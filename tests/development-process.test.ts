import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DevelopmentProcess } from '../scripts/development-process.ts'

function fixture(canStart = () => true) {
  const children: (ChildProcess & { finish: (code?: number) => void })[] = []
  const onQuit = vi.fn(),
    onError = vi.fn(),
    warn = vi.fn()
  const spawn = vi.fn(() => {
    const events = new EventEmitter()
    const child = Object.assign(events, {
      pid: children.length + 1,
      kill: vi.fn(() => true),
      finish(code = 0) {
        events.emit('close', code, null)
      },
    }) as unknown as (typeof children)[number]
    children.push(child)
    return child
  })
  const owner = new DevelopmentProcess({
    spawn,
    onQuit,
    onError,
    warn,
    canStart,
    terminateTimeoutMs: 100,
    killTimeoutMs: 50,
  })
  return { owner, children, spawn, onQuit, onError, warn }
}

afterEach(() => vi.useRealTimers())

describe('development Electron process ownership', () => {
  it('waits for close, not exit or a delivered signal, before replacing Electron', async () => {
    const { owner, children, spawn, onQuit } = fixture()
    await owner.restart()
    const restarting = owner.restart()
    await Promise.resolve()
    expect(children[0]!.kill).toHaveBeenCalledWith('SIGTERM')
    children[0]!.emit('exit', 0, null)
    await Promise.resolve()
    expect(spawn).toHaveBeenCalledTimes(1)
    children[0]!.finish()
    await restarting
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(onQuit).not.toHaveBeenCalled()
    const stopping = owner.stop()
    children[1]!.finish()
    await stopping
  })

  it('coalesces rebuilds during a delayed exit into one replacement', async () => {
    const { owner, children, spawn } = fixture()
    await owner.restart()
    const restarts = [owner.restart(), owner.restart(), owner.restart()]
    await Promise.resolve()
    restarts.push(owner.restart())
    children[0]!.finish()
    await Promise.all(restarts)
    expect(spawn).toHaveBeenCalledTimes(2)
    const stopping = owner.stop()
    children[1]!.finish()
    await stopping
  })

  it('accepts a rebuild in the microtask immediately after a completed spawn', async () => {
    const { owner, children, spawn } = fixture()
    const createChild = spawn.getMockImplementation()!
    let restarting: Promise<void> | undefined
    spawn.mockImplementationOnce(() => {
      const child = createChild()
      queueMicrotask(() => {
        restarting = owner.restart()
      })
      return child
    })
    try {
      await owner.restart()
      expect(children[0]!.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
      children[0]!.finish()
      await restarting
      expect(spawn).toHaveBeenCalledTimes(2)
    } finally {
      children.at(-1)?.finish()
      await owner.stop()
    }
  })

  it('cancels a queued replacement when shutdown starts', async () => {
    const { owner, children, spawn } = fixture()
    await owner.restart()
    const restarting = owner.restart()
    await Promise.resolve()
    const stopping = owner.stop()
    children[0]!.finish()
    await Promise.all([restarting, stopping, owner.restart()])
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(children[0]!.kill).toHaveBeenCalledTimes(1)
  })

  it('waits for corrected output if a build fails while the old process is closing', async () => {
    let valid = true
    const { owner, children, spawn } = fixture(() => valid)
    await owner.restart()
    const restarting = owner.restart()
    await Promise.resolve()
    valid = false
    children[0]!.finish()
    await restarting
    expect(spawn).toHaveBeenCalledTimes(1)
    valid = true
    await owner.restart()
    expect(spawn).toHaveBeenCalledTimes(2)
    valid = false
    await owner.restart()
    expect(children[1]!.kill).not.toHaveBeenCalled()
    const stopping = owner.stop()
    children[1]!.finish()
    await stopping
  })

  it('closes resources on spontaneous quit without waiting again for an exited child', async () => {
    const { owner, children, onQuit, spawn } = fixture()
    onQuit.mockImplementation(() => void owner.stop())
    await owner.restart()
    children[0]!.finish(0)
    await owner.stop()
    await owner.restart()
    expect(onQuit).toHaveBeenCalledExactlyOnceWith(0)
    expect(children[0]!.kill).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('surfaces synchronous and asynchronous spawn failures without retrying', async () => {
    const first = fixture()
    first.spawn.mockImplementation(() => {
      throw new Error('spawn failed')
    })
    await expect(first.owner.restart()).rejects.toThrow('spawn failed')
    await first.owner.stop()
    await first.owner.restart()
    expect(first.spawn).toHaveBeenCalledTimes(1)

    const second = fixture()
    await second.owner.restart()
    const failure = new Error('ENOENT')
    second.children[0]!.emit('error', failure)
    second.children[0]!.finish(-2)
    await second.owner.stop()
    await second.owner.restart()
    expect(second.onError).toHaveBeenCalledExactlyOnceWith(failure)
    expect(second.spawn).toHaveBeenCalledTimes(1)
  })

  it('bounds graceful termination then waits for the same child after SIGKILL', async () => {
    vi.useFakeTimers()
    const { owner, children, spawn, warn } = fixture()
    await owner.restart()
    const restarting = owner.restart()
    await vi.advanceTimersByTimeAsync(100)
    expect(children[0]!.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('SIGTERM'))
    expect(spawn).toHaveBeenCalledTimes(1)
    children[0]!.finish()
    await restarting
    expect(spawn).toHaveBeenCalledTimes(2)
    const stopping = owner.stop()
    children[1]!.finish()
    await stopping
    expect(vi.getTimerCount()).toBe(0)
  })

  it('refuses replacement if termination cannot be confirmed within either bound', async () => {
    vi.useFakeTimers()
    const { owner, children, spawn } = fixture()
    await owner.restart()
    const restarting = expect(owner.restart()).rejects.toThrow('refusing to start a competing')
    await vi.advanceTimersByTimeAsync(150)
    await restarting
    expect(spawn).toHaveBeenCalledTimes(1)
    await expect(owner.stop()).rejects.toThrow('refusing to start a competing')
    expect(children[0]!.kill).toHaveBeenCalledTimes(2)
    children[0]!.finish()
    expect(vi.getTimerCount()).toBe(0)
  })
})
