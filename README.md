# actionspack

[![Open on npmx][npmx-version-src]][npmx-href]
[![npm downloads][npmx-downloads-src]][npmx-href]
[![Unit Test][unit-test-src]][unit-test-href]

`actionspack` is a lockfile-first GitHub Actions workflow packer. It lets you
author workflows in `.github/workflows/src/`, lock every remote workflow/action
dependency in `.github/workflow.lock.yml`, and generate pinned workflows in
`.github/workflows/`.

It currently supports inlining composite actions and safely transformable
reusable workflows. JavaScript and Docker actions are pinned as external
dependencies instead of being bundled.

## Why actionspack?

GitHub Actions workflows often depend on reusable workflows and actions from
other repositories. You may want to author those dependencies with convenient
floating refs like `@main` in `.github/workflows/src/`, but generated workflows
should be reproducible and reviewable.

`actionspack` gives workflows a lockfile mechanism similar to `pnpm`. It locks
remote workflows and actions in `.github/workflow.lock.yml`, inlines everything
that can be transformed safely into the local repository, and pins anything that
cannot be inlined to a fixed SHA.

To update workflow and action dependencies, run `actionspack update`
periodically. The updated lockfile and generated workflows are normal repository
files, so `git diff` shows exactly which dependencies changed and what generated
workflow output changed.

## Install

```bash
npm i actionspack
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
npx actionspack
```

`actionspack` defaults to `actionspack pack`. It writes:

- `.github/workflow.lock.yml`
- `.github/workflows/ci.yml`

Generated workflows are safe to commit. Existing lockfile SHAs are reused until
you explicitly run `actionspack update`.

When you want to refresh workflow/action dependencies:

```bash
npx actionspack update
git diff
```

Review the dependency SHA changes in `.github/workflow.lock.yml` and the
resulting generated workflow changes before committing.

### VS Code

Generated workflows should not be edited by hand. Consider marking them as
read-only in your workspace settings:

```json
{
  "files.readonlyInclude": {
    ".github/workflows/*.yml": true
  }
}
```

## Commands

```bash
actionspack pack
```

Scan source workflows, resolve missing dependencies, update the lockfile, and
write generated workflows.

```bash
actionspack scan
```

Update the lockfile graph shape only. This adds newly discovered dependencies
and removes unreachable ones without refreshing existing SHAs.

```bash
actionspack update [package]
```

Refresh all locked dependencies, or only the selected package. By default this
also packs workflows. Use `--lockfile-only` to update only
`.github/workflow.lock.yml`.

```bash
actionspack verify
```

Check that generated workflows are current and contain no unsupported unpinned
remote references.

```bash
actionspack tree
actionspack why <package>
actionspack diff
actionspack diff --json
```

Inspect the lockfile dependency tree, explain why a package is present, or
compare the current lockfile with `HEAD`.

## Configuration

`actionspack.yml` is optional. Without it, `actionspack` discovers
`.github/workflows/src/*.yml` and `.github/workflows/src/*.yaml`, then writes
matching generated workflows to `.github/workflows/*.yml`.

Use explicit entries when you need custom paths:

```yaml
$schema: ./actionspack.schema.json

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
actionspack pack \
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
import { diff, pack, scan, tree, update, verify, why } from 'actionspack'

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

[npmx-version-src]: https://npmx.dev/api/registry/badge/version/actionspack
[npmx-downloads-src]: https://npmx.dev/api/registry/badge/downloads-month/actionspack
[npmx-href]: https://npmx.dev/actionspack
[unit-test-src]: https://github.com/sxzz/actionspack/actions/workflows/unit-test.yml/badge.svg
[unit-test-href]: https://github.com/sxzz/actionspack/actions/workflows/unit-test.yml
