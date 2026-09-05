import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { SyncIO } from '../src/main/sync/io'

describe('synchronization process boundaries', () => {
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
