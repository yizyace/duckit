import { spawn } from 'node:child_process'
import { join, delimiter } from 'node:path'
import { mkdir, access } from 'node:fs/promises'

export type Runtime = { directory: string; stateRoot: string; signal?: AbortSignal }
export function environment(runtime: Runtime): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'SSH_AUTH_SOCK']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return {
    ...env,
    PATH: [
      join(runtime.directory, 'git/bin'),
      join(runtime.directory, 'git/libexec/git-core'),
      join(runtime.directory, 'dolt/bin'),
      '/usr/bin',
      '/bin',
    ].join(delimiter),
    GIT_EXEC_PATH: join(runtime.directory, 'git/libexec/git-core'),
    GIT_TEMPLATE_DIR: join(runtime.directory, 'git/share/git-core/templates'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    DOLT_ROOT_PATH: runtime.stateRoot,
    DOLT_DISABLE_EVENT_FLUSH: '1',
  }
}
export async function runDolt(
  runtime: Runtime,
  cwd: string,
  args: string[],
  input?: string,
  timeout = 120_000,
): Promise<string> {
  runtime.signal?.throwIfAborted()
  await access(join(runtime.directory, 'dolt/bin/dolt'))
  runtime.signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(join(runtime.directory, 'dolt/bin/dolt'), args, {
      cwd,
      env: environment(runtime),
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = '',
      size = 0,
      failed = false
    const stop = () => {
      if (!child.pid) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* The process group already exited. */
      }
    }
    runtime.signal?.addEventListener('abort', stop, { once: true })
    const timer = setTimeout(() => {
      failed = true
      stop()
    }, timeout)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (bytes: string) => {
      size += Buffer.byteLength(bytes)
      if (size > 256 * 1024 * 1024) {
        failed = true
        stop()
      } else out += bytes
    })
    // Dolt errors can contain SQL/financial values. Never forward raw stderr to renderer/logs.
    child.stderr.resume()
    child.on('error', () => {
      clearTimeout(timer)
      runtime.signal?.removeEventListener('abort', stop)
      reject(new Error('Bundled database process could not start'))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      runtime.signal?.removeEventListener('abort', stop)
      if (runtime.signal?.aborted) reject(new Error('Database operation was cancelled'))
      else if (failed || code !== 0)
        reject(
          new Error(
            failed
              ? 'Database operation timed out or exceeded its size limit'
              : 'Database operation failed; existing data was preserved',
          ),
        )
      else resolve(out)
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}
export async function prepareRuntime(runtime: Runtime): Promise<void> {
  await mkdir(runtime.stateRoot, { recursive: true, mode: 0o700 })
  for (const [key, value] of [
    ['metrics.disabled', 'true'],
    ['versioncheck.disabled', 'true'],
    ['user.name', 'Duckit'],
    ['user.email', 'local@duckit.invalid'],
  ]) {
    await runDolt(runtime, runtime.stateRoot, ['config', '--global', '--add', key!, value!])
  }
}
