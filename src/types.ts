import type { GitHubClient } from './utils/github.ts'

export type { GitHubClient }

export interface FlowpackOptions {
  cwd?: string
  entries?: WorkflowEntry[]
  external?: string[]
  github?: GitHubClient
  stdout?: WritableStream
  stderr?: WritableStream
}

export interface WritableStream {
  write: (chunk: string) => void
}

export interface WorkflowEntry {
  source: string
  output: string
}

export interface FlowpackConfig {
  entries: WorkflowEntry[]
  external: string[]
}

export interface LockDependency {
  package: string
  requested: string
  resolved?: string
  foundAt?: string
}

export interface LockEntry {
  output: string
  dependencies: LockDependency[]
}

export interface LockPackage {
  source: 'github'
  owner: string
  repo: string
  path: string
  requested: string
  resolved: string
  type:
    | 'composite'
    | 'external-action'
    | 'external-workflow'
    | 'reusable-workflow'
  external?: boolean
  contentDigest: string
  dependencies: LockDependency[]
}

export interface Lockfile {
  lockfileVersion: 1
  entries: Record<string, LockEntry>
  packages: Record<string, LockPackage>
}

export interface RemoteRef {
  owner: string
  repo: string
  path: string
  ref: string
  package: string
  kind: 'action' | 'reusable-workflow'
}

export interface ScanOptions extends FlowpackOptions {
  refreshPackages?: Set<string>
}

export interface UpdateOptions extends FlowpackOptions {
  packageName?: string
  lockfileOnly?: boolean
}

export interface DiffOptions extends FlowpackOptions {
  json?: boolean
}

export interface DiffResult {
  added: string[]
  removed: string[]
  changed: Array<{
    package: string
    oldResolved: string
    newResolved: string
    dependencyChanged: boolean
  }>
}

export interface CommandResult {
  lockfile: Lockfile
  entries: WorkflowEntry[]
}
