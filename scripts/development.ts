import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from 'electron-vite'
import { build, createServer, type InlineConfig } from 'vite'
import { DevelopmentProcess } from './development-process.ts'

/** Uses public build APIs so native app restarts can await the outgoing process. */
export async function runDevelopment(): Promise<() => Promise<void>> {
  process.env.NODE_ENV_ELECTRON_VITE = 'development'
  process.env.NODE_ENV = 'development'
  const root = process.cwd()
  const abort = new AbortController()
  const resources: { close: () => Promise<void> }[] = []
  const valid = { main: false, preload: false }
  let initialized = false
  let pendingMainRestart = true
  let rendererUrl: string | undefined
  let reloadPreload: (() => void) | undefined
  let shutdown: Promise<void> | undefined
  const owner = new DevelopmentProcess({
    canStart: () => initialized && valid.main && valid.preload && !abort.signal.aborted,
    spawn: () => {
      const electronPath: unknown = createRequire(resolve(root, 'package.json'))('electron')
      if (typeof electronPath !== 'string') throw new Error('Electron executable is unavailable')
      const args: unknown = process.env.ELECTRON_CLI_ARGS
        ? JSON.parse(process.env.ELECTRON_CLI_ARGS)
        : []
      if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string'))
        throw new Error('ELECTRON_CLI_ARGS must be a JSON array of strings')
      for (const [variable, flag] of [
        ['REMOTE_DEBUGGING_PORT', '--remote-debugging-port'],
        ['V8_INSPECTOR_PORT', '--inspect'],
        ['V8_INSPECTOR_BRK_PORT', '--inspect-brk'],
      ] as const) {
        if (process.env[variable]) args.push(`${flag}=${process.env[variable]}`)
      }
      if (process.env.NO_SANDBOX === '1') args.push('--no-sandbox')
      const child = spawn(electronPath, [process.env.ELECTRON_ENTRY || '.', ...args], {
        cwd: root,
        stdio: 'inherit',
        env: { ...process.env, ELECTRON_RENDERER_URL: rendererUrl! },
      })
      pendingMainRestart = false
      console.log(`[development] Starting Electron ${child.pid ?? '(pending)'}.`)
      return child
    },
    onQuit: (code) => {
      if (code !== 0) console.error(`[development] Electron exited unsuccessfully (${code}).`)
      process.exitCode ||= code
      void stop()
    },
    onError: fail,
    warn: (message) => console.warn(`[development] ${message}`),
  })

  function fail(error: unknown): void {
    console.error('[development]', error)
    process.exitCode = 1
    void stop()
  }

  function stop(): Promise<void> {
    if (shutdown) return shutdown
    abort.abort()
    shutdown = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([owner.stop(), ...resources.map((r) => r.close())])
      for (const result of results)
        if (result.status === 'rejected') {
          console.error('[development] Cleanup failed:', result.reason)
          process.exitCode = 1
        }
      process.off('SIGINT', interrupted)
      process.off('SIGTERM', terminated)
    })
    return shutdown
  }

  const interrupted = () => {
    process.exitCode ||= 130
    void stop()
  }
  const terminated = () => {
    process.exitCode ||= 143
    void stop()
  }
  process.on('SIGINT', interrupted)
  process.on('SIGTERM', terminated)

  async function own<T extends { close: () => Promise<void> }>(resource: T): Promise<T> {
    if (abort.signal.aborted) {
      await resource.close()
      throw new Error('Development startup stopped')
    }
    resources.push(resource)
    return resource
  }

  function launchIfReady(): void {
    if (initialized && valid.main && valid.preload && pendingMainRestart && !abort.signal.aborted)
      void owner.restart().catch(fail)
  }

  async function watch(name: 'main' | 'preload', config: InlineConfig): Promise<void> {
    const watcher = await build({
      ...config,
      mode: 'development',
      build: { ...config.build, watch: {} },
    })
    if (!('on' in watcher)) throw new Error(`${name} did not start a build watcher`)
    await own(watcher)
    await new Promise<void>((ready, reject) => {
      let built = false
      const stopped = () => reject(new Error('Development startup stopped'))
      abort.signal.addEventListener('abort', stopped, { once: true })
      watcher.on('event', (event) => {
        if (abort.signal.aborted) return
        if (event.code === 'BUNDLE_START') valid[name] = false
        if (event.code === 'ERROR') {
          valid[name] = false
          console.error(`[development] ${name} build failed:`, event.error)
          if (!built) reject(event.error)
          return
        }
        if (event.code !== 'BUNDLE_END') return
        valid[name] = true
        console.log(`[development] ${name} built successfully.`)
        if (!built) {
          built = true
          abort.signal.removeEventListener('abort', stopped)
          ready()
        }
        if (name === 'main') pendingMainRestart = true
        else if (initialized && !pendingMainRestart) reloadPreload?.()
        launchIfReady()
      })
      if (abort.signal.aborted) stopped()
    })
  }

  try {
    const resolved = await resolveConfig({ root, mode: 'development' }, 'serve', 'development')
    const { main, preload, renderer } = resolved.config ?? {}
    if (!main || !preload || !renderer)
      throw new Error('Expected main, preload and renderer configs')
    if (abort.signal.aborted) return stop
    await watch('main', main)
    await watch('preload', preload)
    const server = await own(await createServer(renderer))
    await server.listen()
    if (abort.signal.aborted) {
      await server.close()
      return stop
    }
    rendererUrl = server.resolvedUrls?.local[0] ?? server.resolvedUrls?.network[0]
    if (!rendererUrl) throw new Error('Renderer development server has no listening URL')
    reloadPreload = () => server.ws.send({ type: 'full-reload' })
    server.printUrls()
    initialized = true
    launchIfReady()
    return stop
  } catch (error) {
    const wasStopped = abort.signal.aborted
    await stop()
    if (!wasStopped) throw error
    return stop
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void runDevelopment().catch((error: unknown) => {
    console.error('[development]', error)
    process.exitCode = 1
  })
