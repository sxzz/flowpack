import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pack, packScanned, verify } from './pack.ts'
import { scan } from './scan.ts'
import {
  discoverConfig,
  LOCKFILE_PATH,
  readLockfile,
  resolveCwd,
} from './utils/fs.ts'
import { matchesPackageSelector } from './utils/ref.ts'
import { stringifyYaml } from './utils/yaml.ts'
import type {
  ActionspackOptions,
  DiffOptions,
  DiffResult,
  LockDependency,
  Lockfile,
  UpdateOptions,
} from './types.ts'

const execFileAsync = promisify(execFile)

export { pack, scan, verify }

export async function update(options: UpdateOptions = {}): Promise<void> {
  const cwd = resolveCwd(options.cwd)
  const current = await readLockfile(cwd)
  const refreshPackages = selectRefreshPackages(current, options.packageName)
  const scanResult = await scan({ ...options, cwd, refreshPackages })
  if (!options.lockfileOnly) {
    await packScanned(scanResult, options)
  }
}

export async function tree(options: ActionspackOptions = {}): Promise<string> {
  const lockfile = await readLockfile(options.cwd)
  const lines: string[] = []
  for (const [source, entry] of Object.entries(lockfile.entries)) {
    lines.push(source)
    appendDependencyTree(lines, lockfile, entry.dependencies, '')
  }
  const output = `${lines.join('\n')}\n`
  options.stdout?.write(output)
  return output
}

export async function why(
  packageName: string,
  options: ActionspackOptions = {},
): Promise<string> {
  const lockfile = await readLockfile(options.cwd)
  const matches = new Set(
    Object.keys(lockfile.packages).filter((key) =>
      matchesPackageSelector(key, packageName),
    ),
  )
  if (matches.size === 0) {
    throw new Error(`Package is not in the lockfile: ${packageName}`)
  }

  const paths: string[][] = []
  for (const [source, entry] of Object.entries(lockfile.entries)) {
    for (const dependency of entry.dependencies) {
      collectWhyPaths(lockfile, dependency, matches, [source], paths)
    }
  }

  const output =
    paths.length === 0
      ? `${packageName} is not reachable\n`
      : `${packageName} is used by:\n\n${paths.map(formatPath).join('\n\n')}\n`
  options.stdout?.write(output)
  return output
}

export async function diff(
  options: DiffOptions = {},
): Promise<DiffResult | string> {
  const cwd = resolveCwd(options.cwd)
  const current = await readLockfile(cwd)
  const previous = await readHeadLockfile(cwd)
  const result = diffLockfiles(previous, current)
  if (options.json) {
    options.stdout?.write(`${JSON.stringify(result, null, 2)}\n`)
    return result
  }
  const output = formatDiff(result)
  options.stdout?.write(output)
  return output
}

export async function verifyEntryConfig(
  options: ActionspackOptions = {},
): Promise<void> {
  const config = await discoverConfig(options.cwd)
  if (config.entries.length === 0) {
    throw new Error('No workflow entries found in .github/workflows/src')
  }
}

function selectRefreshPackages(
  lockfile: Lockfile,
  selector?: string,
): Set<string> {
  const keys = Object.keys(lockfile.packages)
  if (!selector) {
    return new Set(keys)
  }
  const selected = keys.filter((key) => matchesPackageSelector(key, selector))
  if (selected.length === 0) {
    throw new Error(`Package is not in the lockfile: ${selector}`)
  }
  return new Set(selected)
}

function appendDependencyTree(
  lines: string[],
  lockfile: Lockfile,
  dependencies: LockDependency[],
  prefix: string,
): void {
  dependencies.forEach((dependency, index) => {
    const last = index === dependencies.length - 1
    const item = lockfile.packages[dependency.package]
    const label = item
      ? formatPackageTreeLabel(item)
      : `${dependency.package}@${dependency.requested}`
    lines.push(`${prefix}${last ? '└─' : '├─'} ${label}`)
    if (item) {
      appendDependencyTree(
        lines,
        lockfile,
        item.dependencies,
        `${prefix}${last ? '   ' : '│  '}`,
      )
    }
  })
}

function formatPackageTreeLabel(item: {
  owner: string
  path: string
  repo: string
  requested: string
  resolved: string
}): string {
  const name = `${item.owner}/${item.repo}${item.path === '.' ? '' : `/${item.path}`}`
  const requested = `${name}@${item.requested}`
  return item.requested === item.resolved
    ? requested
    : `${requested} (${item.resolved})`
}

function collectWhyPaths(
  lockfile: Lockfile,
  dependency: LockDependency,
  matches: Set<string>,
  current: string[],
  paths: string[][],
): void {
  const item = lockfile.packages[dependency.package]
  const label = item
    ? `${item.owner}/${item.repo}${item.path === '.' ? '' : `/${item.path}`}`
    : dependency.package
  const next = [...current, label]
  if (matches.has(dependency.package)) {
    paths.push(next)
  }
  item?.dependencies.forEach((child) =>
    collectWhyPaths(lockfile, child, matches, next, paths),
  )
}

function formatPath(path: string[]): string {
  return path
    .map(
      (item, index) =>
        `${'   '.repeat(index)}${index === 0 ? item : `└─ ${item}`}`,
    )
    .join('\n')
}

async function readHeadLockfile(cwd: string): Promise<Lockfile> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['show', `HEAD:${LOCKFILE_PATH}`],
      { cwd },
    )
    const { parse } = await import('yaml')
    const value = parse(stdout) as Lockfile | null
    return value ?? { lockfileVersion: 1, entries: {}, packages: {} }
  } catch {
    return { lockfileVersion: 1, entries: {}, packages: {} }
  }
}

export function diffLockfiles(
  previous: Lockfile,
  current: Lockfile,
): DiffResult {
  const previousKeys = new Set(Object.keys(previous.packages))
  const currentKeys = new Set(Object.keys(current.packages))
  const added = [...currentKeys]
    .filter((key) => !previousKeys.has(key))
    .toSorted()
  const removed = [...previousKeys]
    .filter((key) => !currentKeys.has(key))
    .toSorted()
  const changed = [...currentKeys]
    .filter((key) => previousKeys.has(key))
    .flatMap((key) => {
      const oldPackage = previous.packages[key]!
      const newPackage = current.packages[key]!
      const dependencyChanged =
        stringifyYaml(oldPackage.dependencies) !==
        stringifyYaml(newPackage.dependencies)
      if (oldPackage.resolved === newPackage.resolved && !dependencyChanged) {
        return []
      }
      return [
        {
          package: key,
          oldResolved: oldPackage.resolved,
          newResolved: newPackage.resolved,
          dependencyChanged,
        },
      ]
    })
    .toSorted((a, b) => a.package.localeCompare(b.package))
  return { added, removed, changed }
}

function formatDiff(result: DiffResult): string {
  const lines: string[] = []
  for (const item of result.changed) {
    lines.push(
      item.package,
      `old: ${item.oldResolved}`,
      `new: ${item.newResolved}`,
    )
    if (item.dependencyChanged) {
      lines.push('transitive changes: changed')
    }
    lines.push('')
  }
  if (result.added.length > 0) {
    lines.push('added:', ...result.added.map((item) => `- ${item}`), '')
  }
  if (result.removed.length > 0) {
    lines.push('removed:', ...result.removed.map((item) => `- ${item}`), '')
  }
  if (lines.length === 0) {
    return 'No lockfile changes\n'
  }
  return `${lines.join('\n').trimEnd()}\n`
}
