import { Buffer } from 'node:buffer'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

export interface GitHubClient {
  resolveRef: (owner: string, repo: string, ref: string) => Promise<string>
  readFile: (
    owner: string,
    repo: string,
    ref: string,
    path: string,
  ) => Promise<string | undefined>
}

interface GitHubRefResponse {
  object?: {
    sha?: string
  }
}

interface GitHubContentResponse {
  content?: string
  encoding?: string
}

export class HttpGitHubClient implements GitHubClient {
  readonly #cacheDir: string
  readonly #token: string | undefined

  constructor(
    token: string | undefined = process.env.GITHUB_TOKEN,
    cacheDir: string = path.join(tmpdir(), 'actionspack-github-cache'),
  ) {
    this.#cacheDir = cacheDir
    this.#token = token
  }

  async resolveRef(owner: string, repo: string, ref: string): Promise<string> {
    if (/^[a-f0-9]{40}$/iu.test(ref)) {
      return ref
    }

    const candidates = [`heads/${ref}`, `tags/${ref}`, ref]
    for (const candidate of candidates) {
      const response = await this.#request<GitHubRefResponse>(
        `/repos/${owner}/${repo}/git/ref/${candidate}`,
      )
      const sha = response?.object?.sha
      if (sha) {
        return sha
      }
    }

    throw new Error(`Unable to resolve ${owner}/${repo}@${ref}`)
  }

  async readFile(
    owner: string,
    repo: string,
    ref: string,
    filePath: string,
  ): Promise<string | undefined> {
    const cacheFile = this.#cacheFile(owner, repo, ref, filePath)
    const cached = await readFile(cacheFile, 'utf8').catch(() => undefined)
    if (cached !== undefined) {
      return cached
    }

    const response = await this.#request<GitHubContentResponse>(
      `/repos/${owner}/${repo}/contents/${encodeURIComponentPath(filePath)}?ref=${ref}`,
      true,
    )

    if (!response) {
      return undefined
    }
    if (
      response.encoding !== 'base64' ||
      typeof response.content !== 'string'
    ) {
      throw new Error(
        `Unexpected GitHub content response for ${owner}/${repo}/${filePath}@${ref}`,
      )
    }
    const content = Buffer.from(response.content, 'base64').toString('utf8')
    await mkdir(path.dirname(cacheFile), { recursive: true })
    await writeFile(cacheFile, content, 'utf8')
    return content
  }

  #cacheFile(
    owner: string,
    repo: string,
    ref: string,
    filePath: string,
  ): string {
    return path.join(this.#cacheDir, owner, repo, ref, ...filePath.split('/'))
  }

  async #request<T>(
    pathname: string,
    allowNotFound = false,
  ): Promise<T | undefined> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': 'actionspack',
      'x-github-api-version': '2022-11-28',
    }
    if (this.#token) {
      headers.authorization = `Bearer ${this.#token}`
    }

    const response = await fetch(`https://api.github.com${pathname}`, {
      headers,
    })
    if (response.status === 404 && allowNotFound) {
      return undefined
    }
    if (!response.ok) {
      throw new Error(
        `GitHub API request failed: ${response.status} ${response.statusText}`,
      )
    }
    return (await response.json()) as T
  }
}

function encodeURIComponentPath(filePath: string): string {
  return filePath.split('/').map(encodeURIComponent).join('/')
}
