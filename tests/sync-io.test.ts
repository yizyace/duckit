import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { GitHubError, SyncIO } from '../src/main/sync/io'

describe('synchronization process boundaries', () => {
  it('reuses stored credentials on explicit connect without opening another OAuth grant', async () => {
    const io = new SyncIO({ directory: '/synthetic/runtime', stateRoot: '/synthetic/state' })
    const run = vi
      .spyOn(io, 'run')
      .mockResolvedValue('username=synthetic\npassword=synthetic-secret')
    const api = vi.spyOn(io, 'api').mockResolvedValue({ login: 'synthetic' })
    expect(await io.credential('/synthetic', true)).toBe('synthetic-secret')
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]?.[1]).toEqual(['get', '--no-ui'])
    expect(api).toHaveBeenCalledWith('/user', 'GET', undefined, 'synthetic-secret')
  })

  it('refreshes a revoked credential through explicit forced browser sign-in', async () => {
    const io = new SyncIO({ directory: '/synthetic/runtime', stateRoot: '/synthetic/state' })
    const run = vi
      .spyOn(io, 'run')
      .mockResolvedValueOnce('password=revoked-synthetic-secret')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('password=refreshed-synthetic-secret')
    vi.spyOn(io, 'api').mockRejectedValue(new GitHubError(401))
    expect(await io.credential('/synthetic', true)).toBe('refreshed-synthetic-secret')
    expect(run.mock.calls.map((call) => call[1])).toEqual([
      ['get', '--no-ui'],
      ['github', 'login', '--browser', '--force'],
      ['get', '--no-ui'],
    ])
  })

  it.each([new GitHubError(403), new Error('Synthetic network failure')])(
    'preserves the credential without browser sign-in when validation fails with %s',
    async (failure) => {
      const io = new SyncIO({ directory: '/synthetic/runtime', stateRoot: '/synthetic/state' })
      const run = vi.spyOn(io, 'run').mockResolvedValue('password=synthetic-secret')
      vi.spyOn(io, 'api').mockRejectedValue(failure)
      await expect(io.credential('/synthetic', true)).rejects.toBe(failure)
      expect(run).toHaveBeenCalledTimes(1)
      expect(run.mock.calls[0]?.[1]).toEqual(['get', '--no-ui'])
    },
  )

  it('does not validate or refresh stored credentials interactively during background work', async () => {
    const io = new SyncIO({ directory: '/synthetic/runtime', stateRoot: '/synthetic/state' })
    const run = vi.spyOn(io, 'run').mockResolvedValue('password=synthetic-secret')
    const api = vi.spyOn(io, 'api')
    expect(await io.credential('/synthetic', false)).toBe('synthetic-secret')
    expect(run).toHaveBeenCalledTimes(1)
    expect(api).not.toHaveBeenCalled()
  })

  it('opens browser sign-in only for an explicit connection without a stored credential', async () => {
    const io = new SyncIO({ directory: '/synthetic/runtime', stateRoot: '/synthetic/state' })
    const run = vi
      .spyOn(io, 'run')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('password=synthetic-secret')
    expect(await io.credential('/synthetic', true)).toBe('synthetic-secret')
    expect(run.mock.calls.map((call) => call[1])).toEqual([
      ['get', '--no-ui'],
      ['github', 'login', '--browser'],
      ['get', '--no-ui'],
    ])
  })

  it('keeps missing-credential background checks noninteractive', async () => {
    const io = new SyncIO({ directory: '/synthetic/runtime', stateRoot: '/synthetic/state' })
    const run = vi.spyOn(io, 'run').mockRejectedValue(new Error('No credential'))
    await expect(io.credential('/synthetic', false)).rejects.toThrow('No credential')
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]?.[1]).toEqual(['get', '--no-ui'])
  })

  it('scopes transient credentials to GitHub and redacts failed subprocess output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duckit-sync-io-'))
    try {
      const io = new SyncIO({
        directory: resolve('resources/runtime', process.arch),
        stateRoot: root,
      })
      const output = await io.run(
        process.execPath,
        [
          '-e',
          'console.log(JSON.stringify({key:process.env.GIT_CONFIG_KEY_0,global:process.env.GIT_CONFIG_GLOBAL,interactive:process.env.GCM_INTERACTIVE}))',
        ],
        root,
        'synthetic-secret',
      )
      expect(JSON.parse(output)).toEqual({
        key: 'http.https://github.com/.extraheader',
        global: '/dev/null',
        interactive: 'never',
      })
      const error = await io
        .run(
          process.execPath,
          [
            '-e',
            'console.error(process.env.GIT_CONFIG_VALUE_0);console.log(process.env.GIT_CONFIG_VALUE_0);process.exit(1)',
          ],
          root,
          'synthetic-secret',
        )
        .catch((error: unknown) => error)
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).not.toContain('synthetic-secret')
      expect(String(error)).not.toContain(
        Buffer.from('x-access-token:synthetic-secret').toString('base64'),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('cancels a transport process and its helper process before shutdown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duckit-sync-cancel-'))
    const io = new SyncIO({
      directory: resolve('resources/runtime', process.arch),
      stateRoot: root,
    })
    try {
      const pidFile = join(root, 'pid.json')
      const running = io.run(
        process.execPath,
        [
          '-e',
          'const {spawn}=require("node:child_process");const {writeFileSync}=require("node:fs");const child=spawn("/bin/sleep",["30"]);writeFileSync(process.argv[1],JSON.stringify({child:child.pid}));setInterval(()=>{},1000)',
          pidFile,
        ],
        root,
      )
      // Observe rejection immediately so cancellation never creates an unhandled promise.
      const finished = running.catch((error: unknown) => error)
      let child = 0
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          child = Number(JSON.parse(await readFile(pidFile, 'utf8')).child)
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(child).toBeGreaterThan(0)
      io.cancel()
      expect(await finished).toBeInstanceOf(Error)
      const state = await promisify(execFile)('/bin/ps', ['-p', String(child), '-o', 'stat=']).then(
        (result) => result.stdout.trim(),
        () => '',
      )
      expect(state === '' || state.startsWith('Z')).toBe(true)
      await expect(io.run(process.execPath, ['-e', 'process.exit(0)'], root)).rejects.toThrow(
        'cancelled',
      )
    } finally {
      io.cancel()
      await rm(root, { recursive: true, force: true })
    }
  })
})
