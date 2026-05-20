#!/usr/bin/env node
import process from 'node:process'
import { styleText } from 'node:util'
import { cac } from 'cac'
import pkg from '../package.json' with { type: 'json' }
import { diff, pack, scan, tree, update, verify, why } from './commands.ts'
import type { ActionspackOptions, WorkflowEntry } from './types.ts'

const cli = cac(pkg.name)

interface ConfigFlags {
  entry?: string | string[]
  external?: string | string[]
}

interface UpdateFlags extends ConfigFlags {
  lockfileOnly?: boolean
}

async function main(): Promise<void> {
  cli
    .command('', 'Pack workflows')
    .option(
      '--entry <source:output>',
      'Use an explicit source/output workflow mapping',
    )
    .option(
      '--external <selector>',
      'Pin a workflow or action without bundling it',
    )
    .action(async (flags: ConfigFlags) => {
      const config = normalizeConfigFlags(flags)
      await pack({
        ...config,
        stderr: process.stderr,
        stdout: process.stdout,
      })
    })

  cli
    .command('pack', 'Pack workflows')
    .option(
      '--entry <source:output>',
      'Use an explicit source/output workflow mapping',
    )
    .option(
      '--external <selector>',
      'Pin a workflow or action without bundling it',
    )
    .action(async (flags: ConfigFlags) => {
      const config = normalizeConfigFlags(flags)
      await pack({
        ...config,
        stderr: process.stderr,
        stdout: process.stdout,
      })
    })

  cli
    .command('scan', 'Update the lockfile graph without generating workflows')
    .option(
      '--entry <source:output>',
      'Use an explicit source/output workflow mapping',
    )
    .option(
      '--external <selector>',
      'Pin a workflow or action without bundling it',
    )
    .action(async (flags: ConfigFlags) => {
      const config = normalizeConfigFlags(flags)
      await scan({
        ...config,
        stderr: process.stderr,
        stdout: process.stdout,
      })
    })

  cli
    .command('update [packageName]', 'Refresh locked dependency versions')
    .option(
      '--entry <source:output>',
      'Use an explicit source/output workflow mapping',
    )
    .option(
      '--external <selector>',
      'Pin a workflow or action without bundling it',
    )
    .option('--lockfile-only', 'Write only .github/workflow.lock.yml')
    .action(async (packageName: string | undefined, flags: UpdateFlags) => {
      const { lockfileOnly, ...rest } = flags
      const config = normalizeConfigFlags(rest)
      await update({
        ...config,
        packageName,
        lockfileOnly,
        stderr: process.stderr,
        stdout: process.stdout,
      })
    })

  cli
    .command('tree', 'Show the dependency tree from the lockfile')
    .action(async () => {
      await tree({ stdout: process.stdout })
    })

  cli
    .command('why <packageName>', 'Explain why a dependency exists')
    .action(async (packageName: string) => {
      await why(packageName, { stdout: process.stdout })
    })

  cli
    .command('diff', 'Show lockfile changes compared with HEAD')
    .option('--json', 'Print JSON output')
    .action(async (flags: { json?: boolean }) => {
      await diff({ json: flags.json, stdout: process.stdout })
    })

  cli
    .command('verify', 'Verify lockfile and packed workflows')
    .action(async () => {
      await verify()
    })

  cli.help()
  cli.parse(process.argv, { run: false })
  await cli.runMatchedCommand()
}

function normalizeConfigFlags(
  flags: ConfigFlags,
): Pick<ActionspackOptions, 'entries' | 'external'> {
  return {
    ...(flags.entry ? { entries: normalizeEntries(flags.entry) } : {}),
    ...(flags.external
      ? { external: normalizeStringList(flags.external) }
      : {}),
  }
}

function normalizeEntries(value: string | string[]): WorkflowEntry[] {
  return normalizeStringList(value).map((item) => {
    const [source, ...outputParts] = item.split(':')
    const output = outputParts.join(':')
    if (!source || !output) {
      throw new Error(`Invalid --entry value: ${item}`)
    }
    return { source, output }
  })
}

function normalizeStringList(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value]
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${styleText('red', `actionspack: ${message}`)}\n`)
  process.exitCode = 1
})
