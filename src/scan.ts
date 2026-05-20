import { createHash } from 'node:crypto'
import path from 'node:path'
import { styleText } from 'node:util'
import {
  discoverConfig,
  readLockfile,
  readWorkflowEntry,
  resolveCwd,
  writeLockfile,
} from './utils/fs.ts'
import { HttpGitHubClient } from './utils/github.ts'
import {
  isRemoteUses,
  matchesExternalSelector,
  parseRemoteUses,
} from './utils/ref.ts'
import { parseActionMap, parseWorkflowMap } from './utils/workflow-parser.ts'
import { asArray, asRecord } from './utils/yaml.ts'
import type {
  CommandResult,
  GitHubClient,
  LockDependency,
  Lockfile,
  LockPackage,
  RemoteRef,
  ScanOptions,
  WritableStream,
} from './types.ts'

interface ResolvedDependency extends LockDependency {
  remote: RemoteRef
}

interface ScanContext {
  external: string[]
  stderr?: WritableStream
  stdout?: WritableStream
}

export async function scan(options: ScanOptions = {}): Promise<CommandResult> {
  const cwd = resolveCwd(options.cwd)
  const config = await discoverConfig(cwd, options)
  const previous = await readLockfile(cwd)
  const github = options.github ?? new HttpGitHubClient()
  const lockfile: Lockfile = {
    lockfileVersion: 1,
    entries: {},
    packages: { ...previous.packages },
  }

  const queue: ResolvedDependency[] = []
  for (const entry of config.entries) {
    const workflow = await readWorkflowEntry(cwd, entry)
    const dependencies = collectWorkflowDependencies(workflow, entry.source)
    lockfile.entries[entry.source] = {
      output: entry.output,
      dependencies: dependencies.map(toLockDependency),
    }
    queue.push(...dependencies)
  }

  await resolveQueue(
    lockfile,
    queue,
    previous,
    github,
    options.refreshPackages ?? new Set(),
    {
      external: config.external,
      stderr: options.stderr,
      stdout: options.stdout,
    },
  )
  lockfile.packages = prunePackages(lockfile)
  await writeLockfile(cwd, lockfile)
  return { lockfile, entries: config.entries }
}

export function collectWorkflowDependencies(
  workflow: Record<string, unknown>,
  source: string,
): ResolvedDependency[] {
  const dependencies: ResolvedDependency[] = []
  const jobs = asRecord(workflow.jobs)
  if (!jobs) {
    return dependencies
  }

  for (const [jobId, jobValue] of Object.entries(jobs)) {
    const job = asRecord(jobValue)
    if (!job) {
      continue
    }
    if (typeof job.uses === 'string') {
      if (isRemoteUses(job.uses)) {
        dependencies.push(
          toDependency(
            job.uses,
            'reusable-workflow',
            `${source}#jobs.${jobId}.uses`,
          ),
        )
      }
      continue
    }

    dependencies.push(
      ...collectStepDependencies(
        asArray(job.steps),
        `${source}#jobs.${jobId}.steps`,
      ),
    )
  }

  return uniqueDependencies(dependencies)
}

export function collectStepDependencies(
  steps: unknown[],
  foundAtPrefix: string,
): ResolvedDependency[] {
  const dependencies: ResolvedDependency[] = []
  for (const [index, stepValue] of steps.entries()) {
    const step = asRecord(stepValue)
    if (!step || typeof step.uses !== 'string') {
      continue
    }
    if (isRemoteUses(step.uses)) {
      dependencies.push(
        toDependency(step.uses, 'action', `${foundAtPrefix}[${index}].uses`),
      )
    }
  }
  return uniqueDependencies(dependencies)
}

export async function resolveQueue(
  lockfile: Lockfile,
  queue: ResolvedDependency[],
  previous: Lockfile,
  github: GitHubClient,
  refreshPackages: Set<string>,
  context: ScanContext,
): Promise<void> {
  const seen = new Set<string>()
  const resolvedRefs = new Map<string, string>()
  const warnings = new Set<string>()

  while (queue.length > 0) {
    const dependency = queue.shift()!
    const shouldRefresh = refreshPackages.has(dependency.package)
    const previousPackage = previous.packages[dependency.package]
    const resolved =
      previousPackage?.resolved && !shouldRefresh
        ? previousPackage.resolved
        : await resolveDependencyRef(dependency, github, context, resolvedRefs)
    const seenKey = `${dependency.package}@${resolved}`
    if (seen.has(seenKey)) {
      continue
    }

    const scanned = await scanRemotePackage(
      dependency.remote,
      resolved,
      github,
      context,
      warnings,
    )
    lockfile.packages[dependency.package] = {
      ...scanned,
      requested: dependency.requested,
      resolved,
    }

    seen.add(seenKey)
    queue.push(
      ...scanned.dependencies.map((item) => ({
        ...item,
        remote: parseRemoteUsesFromDependency(item),
      })),
    )
  }
}

async function scanRemotePackage(
  remote: RemoteRef,
  resolved: string,
  github: GitHubClient,
  context: ScanContext,
  warnings: Set<string>,
): Promise<Omit<LockPackage, 'requested' | 'resolved'>> {
  if (remote.kind === 'reusable-workflow') {
    if (isExternal(remote, context.external)) {
      context.stdout?.write(
        `External ${remote.owner}/${remote.repo}/${remote.path}@${resolved}\n`,
      )
      return externalPackage(remote, 'external-workflow')
    }
    const content = await github.readFile(
      remote.owner,
      remote.repo,
      resolved,
      remote.path,
    )
    if (!content) {
      throw new Error(
        `Missing reusable workflow ${remote.owner}/${remote.repo}/${remote.path}@${resolved}`,
      )
    }
    const workflow = parseWorkflowMap(content, remote.path)
    const dependencies = collectWorkflowDependencies(
      workflow,
      `${remote.owner}/${remote.repo}/${remote.path}`,
    )
    return {
      source: 'github',
      owner: remote.owner,
      repo: remote.repo,
      path: remote.path,
      type: 'reusable-workflow',
      contentDigest: digest(content),
      dependencies: dependencies.map(toLockDependency),
    }
  }

  if (isExternal(remote, context.external)) {
    context.stdout?.write(
      `External ${remote.owner}/${remote.repo}/${remote.path}@${resolved}\n`,
    )
    return externalPackage(remote, 'external-action')
  }

  const metadata = await readActionMetadata(github, remote, resolved)
  const action = parseActionMap(metadata.content, `${remote.path}/action.yml`)
  const runs = asRecord(action.runs)
  const using =
    typeof runs?.using === 'string' ? runs.using.toLowerCase() : undefined
  if (using !== 'composite') {
    warnOnce(
      context,
      warnings,
      `Unsupported action type for ${remote.owner}/${remote.repo}/${remote.path}@${resolved}: ${using ?? 'unknown'}; marking external`,
    )
    return {
      ...externalPackage(remote, 'external-action'),
      contentDigest: digest(metadata.content),
    }
  }

  const dependencies = collectStepDependencies(
    asArray(runs?.steps),
    `${remote.owner}/${remote.repo}/${remote.path}#runs.steps`,
  )
  return {
    source: 'github',
    owner: remote.owner,
    repo: remote.repo,
    path: remote.path,
    type: 'composite',
    contentDigest: digest(metadata.content),
    dependencies: dependencies.map(toLockDependency),
  }
}

function resolveDependencyRef(
  dependency: ResolvedDependency,
  github: GitHubClient,
  context: ScanContext,
  resolvedRefs: Map<string, string>,
): Promise<string> {
  const key = `${dependency.package}@${dependency.requested}`
  const resolved = resolvedRefs.get(key)
  if (resolved) {
    return Promise.resolve(resolved)
  }
  context.stdout?.write(
    `Resolving ${dependency.remote.owner}/${dependency.remote.repo}${dependency.remote.path === '.' ? '' : `/${dependency.remote.path}`}@${dependency.requested}\n`,
  )
  return github
    .resolveRef(
      dependency.remote.owner,
      dependency.remote.repo,
      dependency.requested,
    )
    .then((value) => {
      resolvedRefs.set(key, value)
      return value
    })
}

function warnOnce(
  context: ScanContext,
  warnings: Set<string>,
  message: string,
): void {
  if (warnings.has(message)) {
    return
  }
  warnings.add(message)
  context.stderr?.write(`${styleText('yellow', `Warning: ${message}`)}\n`)
}

function isExternal(remote: RemoteRef, selectors: string[]): boolean {
  return selectors.some((selector) => matchesExternalSelector(remote, selector))
}

function externalPackage(
  remote: RemoteRef,
  type: 'external-action' | 'external-workflow',
): Omit<LockPackage, 'requested' | 'resolved'> {
  return {
    source: 'github',
    owner: remote.owner,
    repo: remote.repo,
    path: remote.path,
    type,
    external: true,
    contentDigest: 'external',
    dependencies: [],
  }
}

export async function readActionMetadata(
  github: GitHubClient,
  remote: Pick<RemoteRef, 'owner' | 'repo' | 'path'>,
  resolved: string,
): Promise<{ path: string; content: string }> {
  const base = remote.path === '.' ? '' : `${remote.path.replace(/\/$/u, '')}/`
  for (const name of ['action.yml', 'action.yaml']) {
    const metadataPath = `${base}${name}`
    const content = await github.readFile(
      remote.owner,
      remote.repo,
      resolved,
      metadataPath,
    )
    if (content) {
      return { path: metadataPath, content }
    }
  }
  throw new Error(
    `Missing action metadata for ${remote.owner}/${remote.repo}/${remote.path}@${resolved}`,
  )
}

function parseRemoteUsesFromDependency(dependency: LockDependency): RemoteRef {
  const match = /^github:([^/]+)\/([^/]+)(?:\/(.+))?$/u.exec(dependency.package)
  if (!match) {
    throw new Error(`Unsupported package key: ${dependency.package}`)
  }
  const [, owner, repo, packagePath] = match
  const remotePath = packagePath ?? '.'
  const kind = remotePath.startsWith('.github/workflows/')
    ? 'reusable-workflow'
    : 'action'
  return {
    owner: owner!,
    repo: repo!,
    path: remotePath,
    ref: dependency.requested,
    package: dependency.package,
    kind,
  }
}

function toDependency(
  value: string,
  kind: 'action' | 'reusable-workflow',
  foundAt: string,
): ResolvedDependency {
  const remote = parseRemoteUses(value, kind)
  return {
    package: remote.package,
    requested: remote.ref,
    foundAt,
    remote,
  }
}

function toLockDependency(dependency: LockDependency): LockDependency {
  return {
    package: dependency.package,
    requested: dependency.requested,
    ...(dependency.resolved ? { resolved: dependency.resolved } : {}),
    ...(dependency.foundAt ? { foundAt: dependency.foundAt } : {}),
  }
}

function uniqueDependencies(
  dependencies: ResolvedDependency[],
): ResolvedDependency[] {
  const seen = new Set<string>()
  return dependencies.filter((dependency) => {
    const key = `${dependency.package}@${dependency.requested}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

function prunePackages(lockfile: Lockfile): Record<string, LockPackage> {
  const reachable = new Set<string>()
  const visit = (dependency: LockDependency): void => {
    if (reachable.has(dependency.package)) {
      return
    }
    const item = lockfile.packages[dependency.package]
    if (!item) {
      return
    }
    reachable.add(dependency.package)
    item.dependencies.forEach(visit)
  }

  for (const entry of Object.values(lockfile.entries)) {
    entry.dependencies.forEach(visit)
  }

  return Object.fromEntries(
    [...reachable].toSorted().map((key) => [key, lockfile.packages[key]!]),
  )
}

function digest(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

export function outputForSource(source: string): string {
  return path.posix.join(
    '.github/workflows',
    path.posix.basename(source).replace(/\.ya?ml$/u, '.yml'),
  )
}
