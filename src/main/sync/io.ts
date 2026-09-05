import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { environment, type Runtime } from '../storage/runtime'

export class GitHubError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401 || status === 403
        ? 'GitHub access expired or is insufficient. Reconnect GitHub.'
        : `GitHub request failed (${status}). Your local budget is safe.`,
    )
  }
}

export type SyncOptions = {
  /** Main-process dependency seams for synthetic tests, never exposed over IPC. */
  api?: (path: string, method: string, body: unknown, token: string) => Promise<unknown>
  remoteUrl?: (repository: string) => string
  ref?: string
}

export class SyncIO {
  private stopped = false
  private readonly controller = new AbortController()
  get signal(): AbortSignal {
    return this.controller.signal
  }
  private readonly groups = new Set<number>()
  private readonly requests = new Set<AbortController>()
  assertRunning(): void {
    if (this.stopped) throw new Error('Synchronization was cancelled')
  }
  cancel(): void {
    this.stopped = true
    this.controller.abort(new Error('Synchronization was cancelled'))
    for (const request of this.requests) request.abort()
    for (const pid of this.groups) {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        /* The process group already exited. */
      }
    }
  }
  constructor(
    readonly runtime: Runtime,
    readonly options: SyncOptions = {},
  ) {}
  async run(
    binary: string,
    args: string[],
    cwd: string,
    token?: string,
    input?: string,
    interactive = false,
  ): Promise<string> {
    this.assertRunning()
    const env = { ...environment(this.runtime), GCM_INTERACTIVE: interactive ? 'always' : 'never' }
    if (token)
      Object.assign(env, {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
      })
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, {
        cwd,
        env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      if (child.pid) this.groups.add(child.pid)
      let output = '',
        failed = false
      const stop = () => {
        if (!child.pid) return
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          /* Process group already exited. */
        }
      }
      const timer = setTimeout(
        () => {
          failed = true
          stop()
        },
        interactive ? 180_000 : 45_000,
      )
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        output += chunk
        if (Buffer.byteLength(output) > 16 * 1024 * 1024) {
          failed = true
          stop()
        }
      })
      // Credential output and transport diagnostics must not enter application logs.
      child.stderr.resume()
      child.stdin.on('error', () => {})
      child.on('error', () => {
        clearTimeout(timer)
        if (child.pid) this.groups.delete(child.pid)
        reject(new Error('Bundled synchronization tools could not start'))
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (child.pid) this.groups.delete(child.pid)
        if (failed || code !== 0)
          reject(
            new Error(
              failed
                ? 'Synchronization timed out. Your local budget is safe.'
                : 'Synchronization could not complete. Check GitHub access and network connectivity.',
            ),
          )
        else resolve(output.trim())
      })
      child.stdin.end(input)
    })
  }
  git(args: string[], cwd: string, token: string): Promise<string> {
    return this.run(join(this.runtime.directory, 'git/bin/git'), args, cwd, token)
  }
  dolt(args: string[], cwd: string, token: string): Promise<string> {
    return this.run(join(this.runtime.directory, 'dolt/bin/dolt'), args, cwd, token)
  }
  async credential(cwd: string, connect: boolean): Promise<string> {
    const gcm = join(this.runtime.directory, 'git/libexec/git-core/git-credential-manager')
    if (connect)
      await this.run(gcm, ['github', 'login', '--browser'], cwd, undefined, undefined, true)
    const fields = await this.run(
      gcm,
      ['get', '--no-ui'],
      cwd,
      undefined,
      'protocol=https\nhost=github.com\n\n',
    )
    const token = fields
      .split(/\r?\n/)
      .find((line) => line.startsWith('password='))
      ?.slice(9)
    if (!token) throw new Error('No GitHub credential is available. Connect GitHub in Settings.')
    return token
  }
  async api(path: string, method: string, body: unknown, token: string): Promise<unknown> {
    this.assertRunning()
    if (this.options.api) {
      const result = await this.options.api(path, method, body, token)
      this.assertRunning()
      return result
    }
    const controller = new AbortController()
    this.requests.add(controller)
    try {
      const response = await fetch(`https://api.github.com${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2026-03-10',
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
        redirect: 'error',
      })
      if (!response.ok) throw new GitHubError(response.status)
      const result = response.status === 204 ? null : await response.json()
      this.assertRunning()
      return result
    } finally {
      this.requests.delete(controller)
    }
  }
}
