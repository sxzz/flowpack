import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  diffLockfiles,
  pack,
  scan,
  tree,
  update,
  verify,
  why,
  type GitHubClient,
  type Lockfile,
} from '../src/index.ts'
import { HttpGitHubClient } from '../src/utils/github.ts'
import { substituteString, substituteValue } from '../src/utils/substitute.ts'

class FixtureGitHub implements GitHubClient {
  refs = new Map<string, string>()
  files = new Map<string, string>()
  resolveCalls = new Map<string, number>()

  resolveRef(owner: string, repo: string, ref: string): Promise<string> {
    const key = `${owner}/${repo}@${ref}`
    this.resolveCalls.set(key, (this.resolveCalls.get(key) ?? 0) + 1)
    const resolved = this.refs.get(`${owner}/${repo}@${ref}`)
    if (!resolved) {
      throw new Error(`missing ref ${owner}/${repo}@${ref}`)
    }
    return Promise.resolve(resolved)
  }

  readFile(
    owner: string,
    repo: string,
    ref: string,
    filePath: string,
  ): Promise<string | undefined> {
    return Promise.resolve(
      this.files.get(`${owner}/${repo}@${ref}:${filePath}`),
    )
  }
}

class TestOutput {
  text = ''

  write(chunk: string): void {
    this.text += chunk
  }
}

describe('actionspack', () => {
  it('simplifies static format calls inside expressions', () => {
    const releaseTag =
      "${{ contains(github.ref_name, 'alpha') && 'alpha' || contains(github.ref_name, 'beta') && 'beta' || contains(github.ref_name, 'rc') && 'rc' || '' }}"

    expect(
      substituteString(
        '${{ fromJson(format(\'[{0}]\', \'"ubuntu-latest", "windows-latest"\')) }}',
        {},
      ),
    ).toEqual(['ubuntu-latest', 'windows-latest'])
    expect(
      substituteString(
        "${{ format('{1}-{0}-{2}', 'a', inputs.name, 'b') }}",
        {},
      ),
    ).toBe("${{ format('{0}-a-b', inputs.name) }}")
    expect(
      substituteValue(
        { run: "  ${{ format('{0} install {1}', 'pnpm', '') }}  " },
        {},
      ),
    ).toEqual({ run: 'pnpm install' })
    expect(
      substituteValue(
        {
          tag: releaseTag,
        },
        {},
      ),
    ).toEqual({ tag: releaseTag })
    expect(
      substituteString("${{ inputs.tag || 'latest' }}", {
        'inputs.tag': releaseTag,
      }),
    ).toBe(
      "${{ (contains(github.ref_name, 'alpha') && 'alpha' || contains(github.ref_name, 'beta') && 'beta' || contains(github.ref_name, 'rc') && 'rc' || '') || 'latest' }}",
    )
    expect(
      substituteValue(
        {
          run: "pnpm dlx pkg-pr-new@0.0 publish --pnpm ${{ inputs.compact && '--compact' || '' }} ${{ inputs.packages }} ${{ inputs['comment-package-manager'] && format('--packageManager={0}', inputs['comment-package-manager']) || '' }} ${{ inputs['comment-with-dev'] && '--commentWithDev' || '' }}",
        },
        {
          'inputs.comment-package-manager': 'pnpm,npm,yarn',
          'inputs.comment-with-dev': true,
          'inputs.compact': true,
          'inputs.packages': ". './packages/*'",
        },
      ),
    ).toEqual({
      run: "pnpm dlx pkg-pr-new@0.0 publish --pnpm --compact . './packages/*' --packageManager=pnpm,npm,yarn --commentWithDev",
    })
  })

  it('reports when pack has no source workflows', async () => {
    const cwd = await fixtureRepo({})
    const stdout = new TestOutput()

    await expect(pack({ cwd, stdout })).rejects.toThrow(
      'No workflow source files found in .github/workflows/src',
    )

    expect(stdout.text).toBe('')
  })

  it('packs nested composite actions from .github/workflows/src and writes .github/workflow.lock.yml', async () => {
    const cwd = await fixtureRepo({
      '.github/workflows/src/ci.yml': `
name: CI
on:
  push:
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os: \${{ fromJson(format('[{0}]', '"ubuntu-latest", "windows-latest"')) }}
    steps:
      - uses: acme/root@main
        with:
          message: hello
`,
    })
    const github = new FixtureGitHub()
    github.refs.set(
      'acme/root@main',
      '1111111111111111111111111111111111111111',
    )
    github.refs.set(
      'acme/nested@v1',
      '2222222222222222222222222222222222222222',
    )
    github.files.set(
      'acme/root@1111111111111111111111111111111111111111:action.yml',
      `
name: Root
description: Root action
inputs:
  message:
    required: true
  tool:
    default: pnpm
runs:
  using: composite
  steps:
    - run: echo "\${{ inputs.message }}"
      shell: bash
    - run: echo "\${{ inputs.tool }}"
      shell: bash
    - run: \${{ 'true' == 'true' && 'echo optimized' || 'echo skipped' }}
      shell: bash
    - run: \${{ format('{0} install {1}', inputs.tool, '') }}
      shell: bash
    - uses: acme/nested@v1
      with:
        label: \${{ inputs.tool }}
`,
    )
    github.files.set(
      'acme/nested@2222222222222222222222222222222222222222:action.yml',
      `
name: Nested
description: Nested action
inputs:
  label:
    required: true
runs:
  using: composite
  steps:
    - run: echo nested \${{ inputs.label }}
      shell: bash
`,
    )

    const stdout = new TestOutput()
    await pack({ cwd, github, stdout })
    await verify({ cwd, github })

    const output = await readYaml(path.join(cwd, '.github/workflows/ci.yml'))
    expect(output.jobs.test.steps).toEqual([
      { run: 'echo "hello"', shell: 'bash' },
      { run: 'echo "pnpm"', shell: 'bash' },
      { run: 'echo optimized', shell: 'bash' },
      { run: 'pnpm install', shell: 'bash' },
      { run: 'echo nested pnpm', shell: 'bash' },
    ])
    expect(output.jobs.test.strategy.matrix.os).toEqual([
      'ubuntu-latest',
      'windows-latest',
    ])

    const lockfile = await readYaml(path.join(cwd, '.github/workflow.lock.yml'))
    expect(Object.keys(lockfile.packages)).toEqual([
      'github:acme/nested',
      'github:acme/root',
    ])
    expect(lockfile.entries['.github/workflows/src/ci.yml'].output).toBe(
      '.github/workflows/ci.yml',
    )
    expect(stdout.text).toContain('Resolving acme/root@main\n')
    expect(stdout.text).toContain('Resolving acme/nested@v1\n')
    expect(stdout.text.endsWith('Packed 1 workflow\n')).toBe(true)
  })

  it('scan does not refresh existing locks, while update does', async () => {
    const cwd = await fixtureRepo({
      '.github/workflows/src/ci.yml': `
name: CI
on:
  push:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: acme/root@main
`,
    })
    const github = new FixtureGitHub()
    github.refs.set(
      'acme/root@main',
      '1111111111111111111111111111111111111111',
    )
    github.files.set(
      'acme/root@1111111111111111111111111111111111111111:action.yml',
      `
name: Root
description: Root action
runs:
  using: composite
  steps:
    - run: echo one
      shell: bash
`,
    )

    await pack({ cwd, github })

    github.refs.set(
      'acme/root@main',
      '2222222222222222222222222222222222222222',
    )
    github.files.set(
      'acme/root@2222222222222222222222222222222222222222:action.yml',
      `
name: Root
description: Root action
runs:
  using: composite
  steps:
    - run: echo two
      shell: bash
`,
    )

    await scan({ cwd, github })
    expect(
      (await readLockfile(cwd)).packages['github:acme/root'].resolved,
    ).toBe('1111111111111111111111111111111111111111')

    await update({ cwd, github, lockfileOnly: true })
    expect(
      (await readLockfile(cwd)).packages['github:acme/root'].resolved,
    ).toBe('2222222222222222222222222222222222222222')
  })

  it('does not resolve or warn repeatedly during update packing', async () => {
    const cwd = await fixtureRepo({
      '.github/workflows/src/ci.yml': `
on:
  push:
jobs:
  one:
    runs-on: ubuntu-latest
    steps:
      - uses: acme/js@main
  two:
    runs-on: ubuntu-latest
    steps:
      - uses: acme/js@main
`,
    })
    const github = new FixtureGitHub()
    github.refs.set('acme/js@main', '4444444444444444444444444444444444444444')
    github.files.set(
      'acme/js@4444444444444444444444444444444444444444:action.yml',
      `
name: JS
description: JS action
runs:
  using: node20
  main: dist/index.js
`,
    )
    const stderr = new TestOutput()
    const stdout = new TestOutput()

    await update({ cwd, github, stderr, stdout })

    expect(github.resolveCalls.get('acme/js@main')).toBe(1)
    expect(stdout.text.match(/Resolving acme\/js@main/gu)).toHaveLength(1)
    expect(stderr.text.match(/Unsupported action type/gu)).toHaveLength(1)
    expect(stdout.text).toContain('Packed 1 workflow\n')
  })

  it('inlines safe reusable workflows with renamed jobs and a bridge job', async () => {
    const cwd = await fixtureRepo({
      '.github/workflows/src/ci.yml': `
name: CI
on:
  push:
jobs:
  call:
    uses: acme/reusable/.github/workflows/test.yml@main
    with:
      target: world
  after:
    needs: call
    runs-on: ubuntu-latest
    steps:
      - run: echo after
`,
    })
    const github = new FixtureGitHub()
    github.refs.set(
      'acme/reusable@main',
      '3333333333333333333333333333333333333333',
    )
    github.files.set(
      'acme/reusable@3333333333333333333333333333333333333333:.github/workflows/test.yml',
      `
on:
  workflow_call:
    inputs:
      target:
        type: string
        required: true
jobs:
  build:
    runs-on: ubuntu-latest
    if: \${{ !false }}
    steps:
      - run: echo "\${{ inputs.target }}"
        if: \${{ true }}
      - run: echo deleted
        if: \${{ !true }}
      - run: echo also-deleted
        if: \${{ '' && true }}
`,
    )

    await pack({ cwd, github })

    const output = await readYaml(path.join(cwd, '.github/workflows/ci.yml'))
    expect(output.jobs['call-build'].if).toBeUndefined()
    expect(output.jobs['call-build'].steps).toEqual([{ run: 'echo "world"' }])
    expect(output.jobs.call).toBeUndefined()
    expect(output.jobs.after.needs).toBe('call-build')
  })

  it('externalizes JavaScript actions and fails closed for unsafe reusable workflows', async () => {
    const jsRepo = await fixtureRepo({
      '.github/workflows/src/ci.yml': `
on:
  push:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: acme/js@main
`,
    })
    const github = new FixtureGitHub()
    github.refs.set('acme/js@main', '4444444444444444444444444444444444444444')
    github.files.set(
      'acme/js@4444444444444444444444444444444444444444:action.yml',
      `
name: JS
description: JS action
runs:
  using: node20
  main: dist/index.js
`,
    )

    const stderr = new TestOutput()
    await pack({ cwd: jsRepo, github, stderr })

    const jsOutput = await readYaml(
      path.join(jsRepo, '.github/workflows/ci.yml'),
    )
    expect(jsOutput.jobs.test.steps).toEqual([
      { uses: 'acme/js@4444444444444444444444444444444444444444' },
    ])
    expect(stderr.text).toContain(
      'Warning: Unsupported action type for acme/js/.@4444444444444444444444444444444444444444: node20; marking external',
    )

    const reusableRepo = await fixtureRepo({
      '.github/workflows/src/ci.yml': `
on:
  push:
jobs:
  call:
    uses: acme/reusable/.github/workflows/test.yml@main
    secrets: inherit
`,
    })
    github.refs.set(
      'acme/reusable@main',
      '5555555555555555555555555555555555555555',
    )
    github.files.set(
      'acme/reusable@5555555555555555555555555555555555555555:.github/workflows/test.yml',
      `
on:
  workflow_call:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`,
    )

    await expect(pack({ cwd: reusableRepo, github })).rejects.toThrow(
      'secrets: inherit is not supported',
    )
  })

  it('keeps configured external actions pinned instead of bundling them', async () => {
    const cwd = await fixtureRepo({
      'actionspack.yml': `
external:
  - acme/root
entries:
  - source: .github/workflows/src/ci.yml
    output: .github/workflows/ci.yml
`,
      '.github/workflows/src/ci.yml': `
on:
  push:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: acme/root@main
`,
    })
    const github = new FixtureGitHub()
    github.refs.set(
      'acme/root@main',
      '6666666666666666666666666666666666666666',
    )

    await pack({ cwd, github })

    const output = await readYaml(path.join(cwd, '.github/workflows/ci.yml'))
    expect(output.jobs.test.steps).toEqual([
      { uses: 'acme/root@6666666666666666666666666666666666666666' },
    ])
    const lockfile = await readLockfile(cwd)
    expect(lockfile.packages['github:acme/root'].type).toBe('external-action')
  })

  it('accepts workflow entries from command options', async () => {
    const cwd = await fixtureRepo({
      'ci.source.yml': `
on:
  push:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo option-entry
`,
    })

    await pack({
      cwd,
      entries: [{ source: 'ci.source.yml', output: 'ci.generated.yml' }],
    })

    const output = await readYaml(path.join(cwd, 'ci.generated.yml'))
    expect(output.jobs.test.steps).toEqual([{ run: 'echo option-entry' }])
  })

  it('caches GitHub file reads by sha and path in a temporary directory', async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), 'actionspack-cache-'))
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (() => {
      calls += 1
      return Promise.resolve(
        Response.json({
          content: Buffer.from('runs:\n  using: composite\n').toString(
            'base64',
          ),
          encoding: 'base64',
        }),
      )
    }) as typeof fetch

    try {
      const github = new HttpGitHubClient(undefined, cacheDir)
      await expect(
        github.readFile(
          'acme',
          'cached',
          '7777777777777777777777777777777777777777',
          'action.yml',
        ),
      ).resolves.toContain('using: composite')
      await expect(
        github.readFile(
          'acme',
          'cached',
          '7777777777777777777777777777777777777777',
          'action.yml',
        ),
      ).resolves.toContain('using: composite')
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(calls).toBe(1)
  })

  it('prints tree, why, and lockfile diffs from lockfile data', async () => {
    const cwd = await fixtureRepo({
      '.github/workflow.lock.yml': `
lockfileVersion: 1
entries:
  .github/workflows/src/ci.yml:
    output: .github/workflows/ci.yml
    dependencies:
      - package: github:acme/root
        requested: main
      - package: github:actions/checkout
        requested: de0fac2e4500dabe0009e67214ff5f5447ce83dd
packages:
  github:acme/root:
    source: github
    owner: acme
    repo: root
    path: .
    requested: main
    resolved: old
    type: composite
    contentDigest: sha256:old
    dependencies: []
  github:actions/checkout:
    source: github
    owner: actions
    repo: checkout
    path: .
    requested: de0fac2e4500dabe0009e67214ff5f5447ce83dd
    resolved: de0fac2e4500dabe0009e67214ff5f5447ce83dd
    type: external-action
    external: true
    contentDigest: external
    dependencies: []
`,
    })

    const treeOutput = await tree({ cwd })
    expect(treeOutput).toContain('acme/root@main (old)')
    expect(treeOutput).toContain(
      'actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd\n',
    )
    expect(treeOutput).not.toContain(
      'actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd (de0fac2e4500dabe0009e67214ff5f5447ce83dd)',
    )
    const whyOutput = await why('acme/root', { cwd })
    expect(whyOutput).toContain('.github/workflows/src/ci.yml')

    const previous = await readLockfile(cwd)
    const current: Lockfile = {
      ...previous,
      packages: {
        ...previous.packages,
        'github:acme/root': {
          ...previous.packages['github:acme/root'],
          resolved: 'new',
        },
      },
    }
    expect(diffLockfiles(previous, current).changed).toEqual([
      {
        package: 'github:acme/root',
        oldResolved: 'old',
        newResolved: 'new',
        dependencyChanged: false,
      },
    ])
  })
})

async function fixtureRepo(files: Record<string, string>): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'actionspack-'))
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(cwd, file)
    await import('node:fs/promises').then(({ mkdir }) =>
      mkdir(path.dirname(target), { recursive: true }),
    )
    await writeFile(target, content.trimStart(), 'utf8')
  }
  return cwd
}

async function readYaml(file: string): Promise<Record<string, any>> {
  return parse(await readFile(file, 'utf8')) as Record<string, any>
}

async function readLockfile(cwd: string): Promise<Lockfile> {
  return (await readYaml(
    path.join(cwd, '.github/workflow.lock.yml'),
  )) as Lockfile
}
