import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { optimizeJob, optimizeJobs, optimizeStep } from './optimizer.ts'
import { readActionMetadata, scan } from './scan.ts'
import {
  discoverConfig,
  readLockfile,
  readWorkflowEntry,
  resolveCwd,
  writeWorkflow,
} from './utils/fs.ts'
import { HttpGitHubClient } from './utils/github.ts'
import {
  isPinnedRemoteUses,
  isRemoteUses,
  parseRemoteUses,
  pinnedUses,
} from './utils/ref.ts'
import { normalizeInputValue, substituteValue } from './utils/substitute.ts'
import { parseActionMap, parseWorkflowMap } from './utils/workflow-parser.ts'
import { asArray, asRecord, stringifyWorkflowYaml } from './utils/yaml.ts'
import type {
  ActionspackOptions,
  CommandResult,
  GitHubClient,
  Lockfile,
  LockPackage,
  RemoteRef,
} from './types.ts'

export async function pack(
  options: ActionspackOptions = {},
): Promise<CommandResult> {
  const cwd = resolveCwd(options.cwd)
  const config = await discoverConfig(cwd, options)
  if (config.entries.length === 0) {
    throw new Error('No workflow source files found in .github/workflows/src')
  }

  const scanResult = await scan(options)
  return packScanned(scanResult, options)
}

export async function packScanned(
  scanResult: CommandResult,
  options: ActionspackOptions = {},
): Promise<CommandResult> {
  const cwd = resolveCwd(options.cwd)
  const github = options.github ?? new HttpGitHubClient()

  for (const entry of scanResult.entries) {
    const source = await readWorkflowEntry(cwd, entry)
    const packed = await packWorkflow(source, scanResult.lockfile, github)
    assertNoRemoteUses(packed, entry.output)
    await writeWorkflow(cwd, entry.output, packed)
  }

  options.stdout?.write(
    `Packed ${scanResult.entries.length} workflow${scanResult.entries.length === 1 ? '' : 's'}\n`,
  )
  return scanResult
}

export async function verify(
  options: ActionspackOptions = {},
): Promise<CommandResult> {
  const cwd = resolveCwd(options.cwd)
  const config = await discoverConfig(cwd, options)
  const lockfile = await readLockfile(cwd)
  const github = options.github ?? new HttpGitHubClient()

  for (const entry of config.entries) {
    const source = await readWorkflowEntry(cwd, entry)
    const expected = await packWorkflow(source, lockfile, github)
    assertNoRemoteUses(expected, entry.output)
    const outputPath = path.join(cwd, entry.output)
    const actualText = await readFile(outputPath, 'utf8').catch(() => {
      throw new Error(`Missing generated workflow: ${entry.output}`)
    })
    if (actualText !== stringifyWorkflowYaml(expected)) {
      throw new Error(`Generated workflow is stale: ${entry.output}`)
    }
  }

  return { lockfile, entries: config.entries }
}

export async function packWorkflow(
  workflow: Record<string, unknown>,
  lockfile: Lockfile,
  github: GitHubClient,
): Promise<Record<string, unknown>> {
  const packed = substituteValue(structuredClone(workflow), {}) as Record<
    string,
    unknown
  >
  const jobs = asRecord(packed.jobs)
  if (!jobs) {
    return packed
  }

  const nextJobs: Record<string, unknown> = {}
  const needsReplacements: Record<string, string[]> = {}
  for (const [jobId, jobValue] of Object.entries(jobs)) {
    const job = asRecord(jobValue)
    if (!job) {
      nextJobs[jobId] = jobValue
      continue
    }

    if (typeof job.uses === 'string') {
      if (!isRemoteUses(job.uses)) {
        throw new Error(
          `Local reusable workflows are not transformed yet: jobs.${jobId}.uses`,
        )
      }
      const remote = parseRemoteUses(job.uses, 'reusable-workflow')
      const item = requirePackage(lockfile, remote)
      if (item.external) {
        nextJobs[jobId] = {
          ...job,
          uses: pinnedUses(remote, item.resolved),
        }
        continue
      }
      const inlined = await inlineReusableWorkflow(jobId, job, lockfile, github)
      Object.assign(nextJobs, inlined.jobs)
      needsReplacements[jobId] = inlined.jobIds
      continue
    }

    nextJobs[jobId] = await packJob(job, lockfile, github)
  }

  packed.jobs = optimizeJobs(rewritePackedNeeds(nextJobs, needsReplacements))
  return substituteValue(packed, {}) as Record<string, unknown>
}

async function packJob(
  job: Record<string, unknown>,
  lockfile: Lockfile,
  github: GitHubClient,
): Promise<Record<string, unknown>> {
  const next = { ...job }
  next.steps = await packSteps(asArray(job.steps), lockfile, github)
  return optimizeJob(next)
}

async function packSteps(
  steps: unknown[],
  lockfile: Lockfile,
  github: GitHubClient,
): Promise<unknown[]> {
  const packed: unknown[] = []
  for (const stepValue of steps) {
    const step = asRecord(stepValue)
    if (!step || typeof step.uses !== 'string') {
      const next = optimizeStep(substituteValue(stepValue, {}))
      if (next !== undefined) {
        packed.push(next)
      }
      continue
    }

    if (!isRemoteUses(step.uses)) {
      const next = optimizeStep(stepValue)
      if (next !== undefined) {
        packed.push(next)
      }
      continue
    }

    packed.push(...(await inlineCompositeStep(step, lockfile, github)))
  }
  return packed
}

async function inlineCompositeStep(
  callerStep: Record<string, unknown>,
  lockfile: Lockfile,
  github: GitHubClient,
): Promise<unknown[]> {
  const remote = parseRemoteUses(String(callerStep.uses), 'action')
  const item = requirePackage(lockfile, remote)
  if (item.type !== 'composite') {
    if (item.external) {
      return [
        {
          ...callerStep,
          uses: pinnedUses(remote, item.resolved),
        },
      ]
    }
    throw new Error(`Expected composite action for ${callerStep.uses}`)
  }

  const metadata = await readActionMetadata(github, item, item.resolved)
  const action = parseActionMap(metadata.content, metadata.path)
  if (asRecord(action.outputs) && typeof callerStep.id === 'string') {
    throw new Error(
      `Composite action outputs are not supported for step id ${callerStep.id}`,
    )
  }

  const values = collectActionInputValues(
    action,
    callerStep,
    String(callerStep.uses),
  )
  const runs = asRecord(action.runs)!
  const rawSteps = substituteValue(asArray(runs.steps), values) as unknown[]
  const nested = await packSteps(rawSteps, lockfile, github)
  return nested
    .map((stepValue, index) =>
      optimizeStep(applyCallerStepFields(stepValue, callerStep, index)),
    )
    .filter((stepValue) => stepValue !== undefined)
}

async function inlineReusableWorkflow(
  callerJobId: string,
  callerJob: Record<string, unknown>,
  lockfile: Lockfile,
  github: GitHubClient,
): Promise<{ jobIds: string[]; jobs: Record<string, unknown> }> {
  const remote = parseRemoteUses(String(callerJob.uses), 'reusable-workflow')
  const item = requirePackage(lockfile, remote)
  if (item.type !== 'reusable-workflow') {
    throw new Error(`Expected reusable workflow for ${callerJob.uses}`)
  }
  if (callerJob.secrets === 'inherit') {
    throw new Error(`secrets: inherit is not supported for ${callerJobId}`)
  }
  rejectUnsupportedReusableCallerKeys(callerJob, callerJobId)

  const content = await github.readFile(
    item.owner,
    item.repo,
    item.resolved,
    item.path,
  )
  if (!content) {
    throw new Error(
      `Missing reusable workflow ${item.owner}/${item.repo}/${item.path}@${item.resolved}`,
    )
  }
  const workflow = parseWorkflowMap(content, item.path)
  const call = workflowCallConfig(workflow)
  if (!call) {
    throw new Error(
      `Reusable workflow ${String(callerJob.uses)} must use workflow_call`,
    )
  }
  if (asRecord(call.outputs)) {
    throw new Error(
      `Reusable workflow outputs are not supported for ${callerJobId}`,
    )
  }

  const values = collectReusableValues(call, callerJob, callerJobId)
  const remoteJobs = asRecord(workflow.jobs)
  if (!remoteJobs) {
    throw new Error(`Reusable workflow has no jobs: ${String(callerJob.uses)}`)
  }

  const copied: Record<string, unknown> = {}
  const copiedJobIds = Object.keys(remoteJobs).map(
    (remoteJobId) => `${callerJobId}-${remoteJobId}`,
  )
  for (const [remoteJobId, remoteJobValue] of Object.entries(remoteJobs)) {
    const remoteJob = asRecord(remoteJobValue)
    if (!remoteJob) {
      throw new Error(`Reusable workflow job must be a mapping: ${remoteJobId}`)
    }
    if (remoteJob.uses) {
      throw new Error(
        `Nested reusable workflows are not supported: ${callerJobId}-${remoteJobId}`,
      )
    }
    const transformed = (await packJob(
      substituteValue(remoteJob, values) as Record<string, unknown>,
      lockfile,
      github,
    )) as Record<string, unknown>
    transformed.needs = rewriteReusableNeeds(
      remoteJob.needs,
      callerJob.needs,
      callerJobId,
    )
    copied[`${callerJobId}-${remoteJobId}`] = optimizeJob(transformed)
  }

  return { jobIds: copiedJobIds, jobs: copied }
}

function collectActionInputValues(
  action: Record<string, unknown>,
  callerStep: Record<string, unknown>,
  uses: string,
): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  const supplied = asRecord(callerStep.with) ?? {}
  const inputs = asRecord(action.inputs) ?? {}
  for (const [name, inputValue] of Object.entries(inputs)) {
    const input = asRecord(inputValue) ?? {}
    const suppliedValue = supplied[name]
    const defaultValue = input.default
    const required = input.required === true || input.required === 'true'
    if (suppliedValue === undefined && defaultValue === undefined && required) {
      throw new Error(`Missing required input ${name} for ${uses}`)
    }
    values[`inputs.${name}`] = normalizeInputValue(
      suppliedValue ?? defaultValue,
    )
  }
  for (const [name, value] of Object.entries(supplied)) {
    values[`inputs.${name}`] = normalizeInputValue(value)
  }
  return values
}

function collectReusableValues(
  call: Record<string, unknown>,
  callerJob: Record<string, unknown>,
  jobId: string,
): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  const supplied = asRecord(callerJob.with) ?? {}
  const inputs = asRecord(call.inputs) ?? {}
  for (const [name, inputValue] of Object.entries(inputs)) {
    const input = asRecord(inputValue) ?? {}
    const suppliedValue = supplied[name]
    const defaultValue = input.default
    const required = input.required === true || input.required === 'true'
    if (suppliedValue === undefined && defaultValue === undefined && required) {
      throw new Error(`Missing required workflow input ${name} for ${jobId}`)
    }
    values[`inputs.${name}`] = normalizeInputValue(
      suppliedValue ?? defaultValue,
    )
  }
  for (const [name, value] of Object.entries(supplied)) {
    values[`inputs.${name}`] = normalizeInputValue(value)
  }

  const secrets = asRecord(callerJob.secrets) ?? {}
  const declaredSecrets = asRecord(call.secrets) ?? {}
  for (const name of Object.keys(declaredSecrets)) {
    if (secrets[name] === undefined) {
      const declaration = asRecord(declaredSecrets[name])
      const required =
        declaration?.required === true || declaration?.required === 'true'
      if (required) {
        throw new Error(`Missing required workflow secret ${name} for ${jobId}`)
      }
      continue
    }
    values[`secrets.${name}`] = normalizeInputValue(secrets[name])
  }
  return values
}

function applyCallerStepFields(
  stepValue: unknown,
  callerStep: Record<string, unknown>,
  index: number,
): unknown {
  const step = asRecord(stepValue)
  if (!step) {
    return stepValue
  }
  const next = { ...step }
  if (
    index === 0 &&
    typeof callerStep.name === 'string' &&
    typeof next.name !== 'string'
  ) {
    next.name = callerStep.name
  }
  if (callerStep.if !== undefined) {
    next.if =
      next.if === undefined
        ? callerStep.if
        : `(${String(callerStep.if)}) && (${String(next.if)})`
  }
  if (asRecord(callerStep.env)) {
    const callerEnv = asRecord(callerStep.env)!
    next.env = {
      ...callerEnv,
      ...asRecord(next.env),
    }
  }
  return next
}

function rewriteReusableNeeds(
  remoteNeeds: unknown,
  callerNeeds: unknown,
  callerJobId: string,
): unknown {
  const rewrite = (value: string): string => `${callerJobId}-${value}`
  const rewrittenRemoteNeeds =
    typeof remoteNeeds === 'string'
      ? rewrite(remoteNeeds)
      : Array.isArray(remoteNeeds)
        ? remoteNeeds.map((item) => rewrite(String(item)))
        : []
  const callerNeedsList =
    typeof callerNeeds === 'string'
      ? [callerNeeds]
      : Array.isArray(callerNeeds)
        ? callerNeeds
        : []
  const needs = [...callerNeedsList, ...rewrittenRemoteNeeds]
  return needs.length > 0 ? needs : undefined
}

function rewritePackedNeeds(
  jobs: Record<string, unknown>,
  replacements: Record<string, string[]>,
): Record<string, unknown> {
  if (Object.keys(replacements).length === 0) {
    return jobs
  }
  return Object.fromEntries(
    Object.entries(jobs).map(([jobId, jobValue]) => {
      const job = asRecord(jobValue)
      if (!job) {
        return [jobId, jobValue]
      }
      const next = optimizeJob({
        ...job,
        needs: rewriteNeedsValue(job.needs, replacements),
      })
      return [jobId, next]
    }),
  )
}

function rewriteNeedsValue(
  value: unknown,
  replacements: Record<string, string[]>,
): unknown {
  if (value === undefined) {
    return undefined
  }
  const originalIsString = typeof value === 'string'
  const needs = originalIsString
    ? [value]
    : Array.isArray(value)
      ? value.map(String)
      : []
  const rewritten = needs.flatMap((need) => replacements[need] ?? [need])
  const unique = [...new Set(rewritten)]
  if (unique.length === 0) {
    return undefined
  }
  return originalIsString && unique.length === 1 ? unique[0] : unique
}

function workflowCallConfig(
  workflow: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const on = Reflect.get(workflow, 'on')
  if (on === 'workflow_call') {
    return {}
  }
  if (Array.isArray(on) && on.includes('workflow_call')) {
    return {}
  }
  const onMap = asRecord(on)
  if (!onMap) {
    return undefined
  }
  const call = onMap.workflow_call
  if (call === null) {
    return {}
  }
  return asRecord(call) ?? {}
}

function rejectUnsupportedReusableCallerKeys(
  callerJob: Record<string, unknown>,
  jobId: string,
): void {
  const allowed = new Set([
    'uses',
    'with',
    'secrets',
    'needs',
    'if',
    'permissions',
    'name',
  ])
  for (const key of Object.keys(callerJob)) {
    if (!allowed.has(key)) {
      throw new Error(
        `Unsupported reusable workflow caller key jobs.${jobId}.${key}`,
      )
    }
  }
}

function requirePackage(lockfile: Lockfile, remote: RemoteRef): LockPackage {
  const item = lockfile.packages[remote.package]
  if (!item) {
    throw new Error(`Missing lockfile package for ${remote.package}`)
  }
  return item
}

export function assertNoRemoteUses(value: unknown, file = 'workflow'): void {
  const visit = (item: unknown, trail: string): void => {
    if (Array.isArray(item)) {
      item.forEach((child, index) => visit(child, `${trail}[${index}]`))
      return
    }
    const record = asRecord(item)
    if (!record) {
      return
    }
    if (isRemoteUses(record.uses) && !isPinnedRemoteUses(record.uses)) {
      throw new Error(
        `Packed workflow contains remote action reference at ${file}${trail}.uses: ${record.uses}`,
      )
    }
    for (const [key, child] of Object.entries(record)) {
      visit(child, `${trail}.${key}`)
    }
  }
  visit(value, '')
}
