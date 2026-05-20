import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { parseWorkflowMap } from './workflow-parser.ts'
import { parseYamlMap, stringifyWorkflowYaml, stringifyYaml } from './yaml.ts'
import type {
  ActionspackConfig,
  ActionspackOptions,
  Lockfile,
  WorkflowEntry,
} from '../types.ts'

export const LOCKFILE_PATH = '.github/workflow.lock.yml'
export const DEFAULT_SOURCE_DIR = '.github/workflows/src'
export const DEFAULT_OUTPUT_DIR = '.github/workflows'

export function resolveCwd(cwd?: string): string {
  return cwd ? path.resolve(cwd) : process.cwd()
}

export async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

export async function readYamlFile(
  file: string,
): Promise<Record<string, unknown>> {
  return parseYamlMap(await readFile(file, 'utf8'), file)
}

export async function readWorkflowFile(
  file: string,
): Promise<Record<string, unknown>> {
  return parseWorkflowMap(await readFile(file, 'utf8'), file)
}

export async function writeYamlFile(
  file: string,
  value: unknown,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, stringifyYaml(value), 'utf8')
}

export async function discoverConfig(
  cwd?: string,
  overrides: Pick<ActionspackOptions, 'entries' | 'external'> = {},
): Promise<ActionspackConfig> {
  const root = resolveCwd(cwd)
  const configPath = path.join(root, 'actionspack.yml')
  let config: ActionspackConfig
  if (await fileExists(configPath)) {
    const rawConfig = await readYamlFile(configPath)
    const entries = Array.isArray(rawConfig.entries) ? rawConfig.entries : []
    config = {
      entries: entries.map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          throw new TypeError('actionspack.yml entries must be mappings')
        }
        const source = Reflect.get(entry, 'source')
        const output = Reflect.get(entry, 'output')
        if (typeof source !== 'string' || typeof output !== 'string') {
          throw new TypeError(
            'actionspack.yml entries require source and output',
          )
        }
        return { source, output }
      }),
      external: normalizeStringList(rawConfig.external),
    }
  } else {
    config = await discoverDefaultConfig(root)
  }

  return {
    ...config,
    ...normalizeConfigOverrides(overrides),
  }
}

async function discoverDefaultConfig(root: string): Promise<ActionspackConfig> {
  const sourceDir = path.join(root, DEFAULT_SOURCE_DIR)
  if (!(await fileExists(sourceDir))) {
    return { entries: [], external: [] }
  }

  const names = await readdir(sourceDir)
  return {
    external: [],
    entries: names
      .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
      .toSorted()
      .map((name) => ({
        source: path.posix.join(DEFAULT_SOURCE_DIR, name),
        output: path.posix.join(
          DEFAULT_OUTPUT_DIR,
          name.replace(/\.ya?ml$/u, '.yml'),
        ),
      })),
  }
}

function normalizeConfigOverrides(
  overrides: Pick<ActionspackOptions, 'entries' | 'external'>,
): Partial<ActionspackConfig> {
  return {
    ...(overrides.entries ? { entries: overrides.entries } : {}),
    ...(overrides.external ? { external: overrides.external } : {}),
  }
}

function normalizeStringList(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value]
  }
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((item) => typeof item === 'string')
}

export function readWorkflowEntry(
  root: string,
  entry: WorkflowEntry,
): Promise<Record<string, unknown>> {
  return readWorkflowFile(path.join(root, entry.source))
}

export function emptyLockfile(): Lockfile {
  return {
    lockfileVersion: 1,
    entries: {},
    packages: {},
  }
}

export async function readLockfile(cwd?: string): Promise<Lockfile> {
  const root = resolveCwd(cwd)
  const file = path.join(root, LOCKFILE_PATH)
  if (!(await fileExists(file))) {
    return emptyLockfile()
  }
  const value = await readYamlFile(file)
  return {
    lockfileVersion: 1,
    entries: normalizeRecord(value.entries),
    packages: normalizeRecord(value.packages),
  }
}

export async function writeLockfile(
  cwd: string | undefined,
  lockfile: Lockfile,
): Promise<void> {
  await writeYamlFile(path.join(resolveCwd(cwd), LOCKFILE_PATH), lockfile)
}

export async function writeWorkflow(
  cwd: string | undefined,
  output: string,
  workflow: unknown,
): Promise<void> {
  const file = path.join(resolveCwd(cwd), output)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, stringifyWorkflowYaml(workflow), 'utf8')
}

function normalizeRecord<T>(value: unknown): Record<string, T> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const record: Record<string, T> = value as Record<string, T>
  return record
}
