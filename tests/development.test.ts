import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  resolveConfig: vi.fn(),
  build: vi.fn(),
  createServer: vi.fn(),
  spawn: vi.fn(),
}))
vi.mock('electron-vite', () => ({ resolveConfig: api.resolveConfig }))
vi.mock('vite', () => ({ build: api.build, createServer: api.createServer }))
vi.mock('node:child_process', () => ({ spawn: api.spawn }))
vi.mock('node:module', () => ({ createRequire: () => () => '/synthetic/Electron' }))
import { runDevelopment } from '../scripts/development.ts'

class Watcher extends EventEmitter {
  readonly close = vi.fn(async () => {})
  constructor(private readonly initialError?: Error) {
    super()
  }
  override on(event: string, listener: (...args: unknown[]) => void): this {
    super.on(event, listener)
    queueMicrotask(() => {
      this.emit('event', { code: 'BUNDLE_START' })
      this.emit(
        'event',
        this.initialError ? { code: 'ERROR', error: this.initialError } : { code: 'BUNDLE_END' },
      )
    })
    return this
  }
}

function fixture(initialError?: Error) {
  const main = new Watcher(initialError),
    preload = new Watcher()
  const server = {
    close: vi.fn(async () => {}),
    listen: vi.fn(async () => {}),
    printUrls: vi.fn(),
    ws: { send: vi.fn() },
    resolvedUrls: { local: ['http://localhost:5181/'] },
  }
  const children: (EventEmitter & { kill: ReturnType<typeof vi.fn> })[] = []
  api.resolveConfig.mockResolvedValue({
    config: { main: { root: 'main' }, preload: { root: 'preload' }, renderer: {} },
  })
  api.build.mockImplementation(async ({ root }: { root: string }) =>
    root === 'main' ? main : preload,
  )
  api.createServer.mockResolvedValue(server)
  api.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      pid: children.length + 1,
      kill: vi.fn(() => {
        queueMicrotask(() => child.emit('close', 0, null))
        return true
      }),
    })
    children.push(child)
    return child as unknown as ChildProcess
  })
  return { main, preload, server, children }
}

const exitCode = process.exitCode
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('NODE_ENV_ELECTRON_VITE', '')
  for (const key of [
    'REMOTE_DEBUGGING_PORT',
    'V8_INSPECTOR_PORT',
    'V8_INSPECTOR_BRK_PORT',
    'ELECTRON_CLI_ARGS',
    'ELECTRON_ENTRY',
    'NO_SANDBOX',
  ])
    vi.stubEnv(key, '')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  process.exitCode = undefined
})
afterEach(() => {
  process.exitCode = exitCode
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('development build coordination', () => {
  it('launches after both initial builds using the listening renderer URL, then closes all resources on quit', async () => {
    const { server, children, main, preload } = fixture()
    vi.stubEnv('REMOTE_DEBUGGING_PORT', '0')
    const stop = await runDevelopment()
    await vi.waitFor(() => expect(api.spawn).toHaveBeenCalledTimes(1))
    expect(api.build).toHaveBeenCalledTimes(2)
    expect(server.listen).toHaveBeenCalledTimes(1)
    expect(api.spawn).toHaveBeenCalledWith(
      '/synthetic/Electron',
      ['.', '--remote-debugging-port=0'],
      expect.objectContaining({
        stdio: 'inherit',
        env: expect.objectContaining({ ELECTRON_RENDERER_URL: 'http://localhost:5181/' }),
      }),
    )
    children[0]!.emit('close', 0, null)
    await stop()
    for (const resource of [main, preload, server]) expect(resource.close).toHaveBeenCalledOnce()
    expect(children[0]!.kill).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(0)
  })

  it('keeps the old app during a failed rebuild and reloads or restarts only corrected output', async () => {
    const { main, preload, server, children } = fixture()
    const stop = await runDevelopment()
    try {
      await vi.waitFor(() => expect(api.spawn).toHaveBeenCalledTimes(1))
      preload.emit('event', { code: 'BUNDLE_START' })
      preload.emit('event', { code: 'ERROR', error: new Error('preload syntax') })
      expect(server.ws.send).not.toHaveBeenCalled()
      expect(children[0]!.kill).not.toHaveBeenCalled()
      expect(process.exitCode).toBeUndefined()
      preload.emit('event', { code: 'BUNDLE_END' })
      expect(server.ws.send).toHaveBeenCalledExactlyOnceWith({ type: 'full-reload' })
      main.emit('event', { code: 'BUNDLE_START' })
      main.emit('event', { code: 'ERROR', error: new Error('main syntax') })
      expect(children[0]!.kill).not.toHaveBeenCalled()
      main.emit('event', { code: 'BUNDLE_END' })
      await vi.waitFor(() => expect(api.spawn).toHaveBeenCalledTimes(2))
      expect(children[0]!.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
      expect(console.error).toHaveBeenCalledWith(
        '[development] main build failed:',
        expect.objectContaining({ message: 'main syntax' }),
      )
    } finally {
      await stop()
    }
  })

  it('waits for both outputs when another build becomes invalid during an outgoing close', async () => {
    const { main, preload, children } = fixture()
    const stop = await runDevelopment()
    try {
      await vi.waitFor(() => expect(api.spawn).toHaveBeenCalledTimes(1))
      children[0]!.kill.mockImplementation(() => true)
      main.emit('event', { code: 'BUNDLE_END' })
      await vi.waitFor(() => expect(children[0]!.kill).toHaveBeenCalled())
      preload.emit('event', { code: 'BUNDLE_START' })
      preload.emit('event', { code: 'ERROR', error: new Error('preload syntax') })
      children[0]!.emit('close', 0, null)
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(api.spawn).toHaveBeenCalledTimes(1)
      preload.emit('event', { code: 'BUNDLE_END' })
      await vi.waitFor(() => expect(api.spawn).toHaveBeenCalledTimes(2))
    } finally {
      await stop()
    }
  })

  it('rejects an initial build failure and closes its watcher without launching Electron', async () => {
    const { main } = fixture(new Error('initial syntax'))
    const listeners = process.listenerCount('SIGTERM')
    await expect(runDevelopment()).rejects.toThrow('initial syntax')
    expect(main.close).toHaveBeenCalledOnce()
    expect(api.createServer).not.toHaveBeenCalled()
    expect(api.spawn).not.toHaveBeenCalled()
    expect(process.listenerCount('SIGTERM')).toBe(listeners)
  })

  it('closes both build watchers when renderer setup fails', async () => {
    const { main, preload } = fixture()
    api.createServer.mockRejectedValue(new Error('server startup failed'))
    await expect(runDevelopment()).rejects.toThrow('server startup failed')
    expect(main.close).toHaveBeenCalledOnce()
    expect(preload.close).toHaveBeenCalledOnce()
    expect(api.spawn).not.toHaveBeenCalled()
  })

  it('reports a failed spawn and closes every development resource', async () => {
    const { main, preload, server } = fixture()
    api.spawn.mockImplementation(() => {
      throw new Error('spawn failed')
    })
    const stop = await runDevelopment()
    await vi.waitFor(() => expect(process.exitCode).toBe(1))
    await stop()
    for (const resource of [main, preload, server]) expect(resource.close).toHaveBeenCalledOnce()
    expect(console.error).toHaveBeenCalledWith(
      '[development]',
      expect.objectContaining({ message: 'spawn failed' }),
    )
  })

  it('makes cleanup failures visible and unsuccessful', async () => {
    const { server } = fixture()
    server.close.mockRejectedValue(new Error('close failed'))
    const stop = await runDevelopment()
    await stop()
    expect(process.exitCode).toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      '[development] Cleanup failed:',
      expect.objectContaining({ message: 'close failed' }),
    )
  })
})
