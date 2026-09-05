import type { ChildProcess } from 'node:child_process'

interface ProcessOwnerOptions {
  spawn: () => ChildProcess
  onQuit: (code: number) => void
  onError: (error: Error) => void
  warn: (message: string) => void
  canStart?: () => boolean
  terminateTimeoutMs?: number
  killTimeoutMs?: number
}

interface OwnedProcess {
  child: ChildProcess
  closed: Promise<void>
  hasClosed: boolean
  expectedClose: boolean
  termination?: Promise<void>
}

async function closesWithin(closed: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      closed.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Owns one Electron child; a signal alone never authorizes its replacement. */
export class DevelopmentProcess {
  private current: OwnedProcess | undefined
  private requested = false
  private stopping = false
  private work: Promise<void> | undefined
  private shutdown: Promise<void> | undefined
  private readonly options: ProcessOwnerOptions

  constructor(options: ProcessOwnerOptions) {
    this.options = options
  }

  restart(): Promise<void> {
    if (this.stopping) return Promise.resolve()
    this.requested = true
    this.work ??= Promise.resolve().then(() => this.replace())
    return this.work
  }

  stop(): Promise<void> {
    this.stopping = true
    this.requested = false
    this.shutdown ??= (async () => {
      // The restart caller reports its failure. Still attempt owned-child cleanup.
      await this.work?.catch(() => {})
      if (this.current) await this.terminate(this.current)
    })()
    return this.shutdown
  }

  private async replace(): Promise<void> {
    try {
      while (this.requested && !this.stopping) {
        if (this.options.canStart?.() === false) {
          this.requested = false
          return
        }
        if (this.current) await this.terminate(this.current)
        if (this.stopping) return
        // All rebuilds received while waiting for close share this latest launch.
        this.requested = false
        if (this.options.canStart?.() === false) return
        const child = this.options.spawn()
        let resolveClose!: () => void
        const owned: OwnedProcess = {
          child,
          closed: new Promise<void>((resolve) => {
            resolveClose = resolve
          }),
          hasClosed: false,
          expectedClose: false,
        }
        this.current = owned
        child.on('error', (error) => {
          this.stopping = true
          this.options.onError(error)
        })
        child.once('close', (code) => {
          owned.hasClosed = true
          resolveClose()
          if (this.current === owned) this.current = undefined
          if (!owned.expectedClose && !this.stopping) {
            this.stopping = true
            this.requested = false
            this.options.onQuit(code ?? 1)
          }
        })
      }
    } catch (error) {
      this.stopping = true
      throw error
    } finally {
      // Clear before this async method settles: a rebuild in the following
      // microtask must start a new drain instead of joining already-finished work.
      this.work = undefined
    }
  }

  private terminate(owned: OwnedProcess): Promise<void> {
    owned.termination ??= (async () => {
      if (owned.hasClosed) return
      owned.expectedClose = true
      owned.child.kill('SIGTERM')
      if (await closesWithin(owned.closed, this.options.terminateTimeoutMs ?? 15_000)) return
      this.options.warn(
        `Electron ${owned.child.pid ?? '(unstarted)'} did not close after SIGTERM; sending SIGKILL.`,
      )
      owned.child.kill('SIGKILL')
      if (await closesWithin(owned.closed, this.options.killTimeoutMs ?? 2_000)) return
      throw new Error(
        `Electron ${owned.child.pid ?? '(unstarted)'} did not close after SIGKILL; refusing to start a competing process.`,
      )
    })()
    return owned.termination
  }
}
