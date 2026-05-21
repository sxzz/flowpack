import type { RemoteRef } from '../types.ts'

const REMOTE_USES_RE = /^[\w.-]+\/[\w.-]+(?:\/[^@\s]+)?@[^@\s]+$/

export function isRemoteUses(value: unknown): value is string {
  return typeof value === 'string' && REMOTE_USES_RE.test(value)
}

export function isPinnedRemoteUses(value: unknown): value is string {
  return isRemoteUses(value) && /@[a-f0-9]{40}$/iu.test(value)
}

export function parseRemoteUses(
  value: string,
  kind: 'action' | 'reusable-workflow' = 'action',
): RemoteRef {
  const atIndex = value.lastIndexOf('@')
  if (atIndex <= 0 || atIndex === value.length - 1) {
    throw new Error(`Malformed remote reference: ${value}`)
  }

  const ref = value.slice(atIndex + 1)
  const spec = value.slice(0, atIndex)
  const parts = spec.split('/')
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new Error(`Malformed remote reference: ${value}`)
  }

  const owner = parts[0]!
  const repo = parts[1]!
  const path = parts.length > 2 ? parts.slice(2).join('/') : '.'
  const inferredKind = path.startsWith('.github/workflows/')
    ? 'reusable-workflow'
    : kind

  return {
    owner,
    repo,
    path,
    ref,
    package:
      path && path !== '.'
        ? `github:${owner}/${repo}/${path}`
        : `github:${owner}/${repo}`,
    kind: inferredKind,
  }
}

export function matchesPackageSelector(key: string, selector: string): boolean {
  const normalized = selector.startsWith('github:')
    ? selector
    : `github:${selector}`
  return (
    key === normalized ||
    key.startsWith(`${normalized}/`) ||
    key.includes(`:${selector}/`)
  )
}

export function matchesExternalSelector(
  remote: RemoteRef,
  selector: string,
): boolean {
  const value = selector.replace(/^github:/u, '')
  const fullName = `${remote.owner}/${remote.repo}`
  const withPath = `${fullName}/${remote.path}`
  const packageSelector = `github:${value}`
  return (
    remote.package === selector ||
    remote.package === packageSelector ||
    fullName === value ||
    withPath === value ||
    remote.package.startsWith(`${packageSelector}/`)
  )
}

export function pinnedUses(remote: RemoteRef, resolved: string): string {
  const base =
    remote.path === '.'
      ? `${remote.owner}/${remote.repo}`
      : `${remote.owner}/${remote.repo}/${remote.path}`
  return `${base}@${resolved}`
}
