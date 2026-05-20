# flowpack

[![Open on npmx][npmx-version-src]][npmx-href]
[![npm downloads][npmx-downloads-src]][npmx-href]
[![Unit Test][unit-test-src]][unit-test-href]

`flowpack` is a lockfile-first GitHub Actions workflow packer. It lets you
author workflows in `.github/workflows/src/`, lock every remote workflow/action
dependency in `.github/workflow.lock.yml`, and generate pinned workflows in
`.github/workflows/`.

It currently supports inlining composite actions and safely transformable
reusable workflows. JavaScript and Docker actions are pinned as external
dependencies instead of being bundled.

## Install

```bash
npm i flowpack
```

## Usage

Put authored workflows under `.github/workflows/src/`:

```yaml
# .github/workflows/src/ci.yml
name: CI

on:
  push:

jobs:
  test:
    uses: owner/repo/.github/workflows/test.yml@main
```

Then run:

```bash
npx flowpack
```

`flowpack` defaults to `flowpack pack`. It writes:

- `.github/workflow.lock.yml`
- `.github/workflows/ci.yml`

Generated workflows are safe to commit. Existing lockfile SHAs are reused until
you explicitly run `flowpack update`.

## Commands

```bash
flowpack pack
```

Scan source workflows, resolve missing dependencies, update the lockfile, and
write generated workflows.

```bash
flowpack scan
```

Update the lockfile graph shape only. This adds newly discovered dependencies
and removes unreachable ones without refreshing existing SHAs.

```bash
flowpack update [package]
```

Refresh all locked dependencies, or only the selected package. By default this
also packs workflows. Use `--lockfile-only` to update only
`.github/workflow.lock.yml`.

```bash
flowpack verify
```

Check that generated workflows are current and contain no unsupported unpinned
remote references.

```bash
flowpack tree
flowpack why <package>
flowpack diff
flowpack diff --json
```

Inspect the lockfile dependency tree, explain why a package is present, or
compare the current lockfile with `HEAD`.

## Configuration

`flowpack.yml` is optional. Without it, `flowpack` discovers
`.github/workflows/src/*.yml` and `.github/workflows/src/*.yaml`, then writes
matching generated workflows to `.github/workflows/*.yml`.

Use explicit entries when you need custom paths:

```yaml
$schema: ./flowpack.schema.json

entries:
  - source: .github/workflows/src/ci.yml
    output: .github/workflows/ci.yml
```

Use `external` to pin a workflow or action without bundling it:

```yaml
external:
  - actions/checkout
  - owner/repo/path
```

The same configuration can be supplied through CLI flags:

```bash
flowpack pack \
  --entry .github/workflows/src/ci.yml:.github/workflows/ci.yml \
  --external actions/checkout
```

## Packing Rules

Composite actions are recursively inlined when `runs.using` is `composite`.
Inputs are substituted from caller `with` values or action defaults. Missing
required inputs fail closed.

Reusable workflows are inlined only when they use `workflow_call` and can be
transformed into local jobs deterministically. Unsupported cases, unresolved
refs, unsafe reusable workflows, and leftover remote `uses` fail closed.

JavaScript actions, Docker actions, and `docker://` references are not bundled
yet. They are pinned to locked SHAs as external dependencies.

## API

```ts
import { diff, pack, scan, tree, update, verify, why } from 'flowpack'

await pack()
await update({ packageName: 'owner/repo', lockfileOnly: true })
await verify()
```

## Sponsors

<p align="center">
  <a href="https://cdn.jsdelivr.net/gh/sxzz/sponsors/sponsors.svg">
    <img src='https://cdn.jsdelivr.net/gh/sxzz/sponsors/sponsors.svg'/>
  </a>
</p>

## License

[MIT](./LICENSE) License © 2026-PRESENT [Kevin Deng](https://github.com/sxzz)

<!-- Badges -->

[npmx-version-src]: https://npmx.dev/api/registry/badge/version/flowpack
[npmx-downloads-src]: https://npmx.dev/api/registry/badge/downloads-month/flowpack
[npmx-href]: https://npmx.dev/flowpack
[unit-test-src]: https://github.com/sxzz/flowpack/actions/workflows/unit-test.yml/badge.svg
[unit-test-href]: https://github.com/sxzz/flowpack/actions/workflows/unit-test.yml
