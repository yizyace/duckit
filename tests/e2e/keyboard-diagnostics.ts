import type { ElectronApplication, Page, TestInfo } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { release } from 'node:os'

// Observation only: no input cancellation, focus changes, scrolling or test waits.
// The test always uses a synthetic DUCKIT_TEST_ROOT before installing this probe.
export async function observeKeyboard(app: ElectronApplication, page: Page) {
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!
    const contents = window.webContents
    const events: unknown[] = []
    const snapshot = () => ({
      time: Date.now(),
      uptime: process.uptime(),
      windowFocused: window.isFocused(),
      contentsFocused: contents.isFocused(),
      visible: window.isVisible(),
      minimized: window.isMinimized(),
      bounds: window.getBounds(),
    })
    const record = (name: string, detail?: unknown) => {
      if (events.length < 1000) events.push({ name, detail, ...snapshot() })
    }
    const listeners: Array<() => void> = []
    const observe = (emitter: NodeJS.EventEmitter, name: string, prefix: string) => {
      const listener = () => record(`${prefix}:${name}`)
      emitter.on(name, listener)
      listeners.push(() => emitter.removeListener(name, listener))
    }
    for (const name of ['focus', 'blur', 'show', 'hide']) {
      observe(window, name, 'window')
    }
    for (const name of ['focus', 'blur']) {
      observe(contents, name, 'contents')
    }
    const input = (event: Electron.Event, detail: Electron.Input) => {
      record('before-input-event', { ...detail, defaultPrevented: event.defaultPrevented })
    }
    contents.on('before-input-event', input)
    listeners.push(() => contents.removeListener('before-input-event', input))
    record('installed')
    ;(globalThis as typeof globalThis & { keyboardDiagnostic: () => unknown }).keyboardDiagnostic =
      () => {
        record('finished')
        for (const remove of listeners) remove()
        return { versions: process.versions, arch: process.arch, events }
      }
  })
  await page.evaluate(() => {
    const events: unknown[] = []
    const frames: unknown[] = []
    const ids = new WeakMap<Node, number>()
    let nextId = 1
    let observedGrid: Element | null = null
    const identity = (value: EventTarget | null) => {
      if (!(value instanceof Node)) return value === window ? { name: 'window' } : null
      if (!ids.has(value)) ids.set(value, nextId++)
      return {
        id: ids.get(value),
        name: value.nodeName,
        connected: value.isConnected,
        ...(value instanceof Element
          ? {
              role: value.getAttribute('role'),
              label: value.getAttribute('aria-label'),
              className: value.className,
              text: value.textContent?.slice(0, 160),
            }
          : {}),
      }
    }
    const grid = () => {
      const current = document.querySelector(
        '[aria-label="Budget grid; scroll horizontally for more months"]',
      )
      observedGrid ??= current
      return current
    }
    const snapshot = () => {
      const element = grid()
      const style = element ? getComputedStyle(element) : null
      const selection = document.getSelection()
      return {
        time: performance.timeOrigin + performance.now(),
        active: identity(document.activeElement),
        focused: document.hasFocus(),
        visibility: document.visibilityState,
        grid: identity(element),
        originalGrid: identity(observedGrid),
        left: element?.scrollLeft,
        top: element?.scrollTop,
        width: element?.scrollWidth,
        client: element?.clientWidth,
        rect: element?.getBoundingClientRect().toJSON(),
        style: style && {
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          direction: style.direction,
          writingMode: style.writingMode,
          scrollBehavior: style.scrollBehavior,
          scrollSnapType: style.scrollSnapType,
        },
        viewport: {
          width: innerWidth,
          height: innerHeight,
          documentWidth: document.documentElement.scrollWidth,
        },
        selection: selection && {
          text: selection.toString().slice(0, 160),
          anchor: identity(selection.anchorNode),
          anchorOffset: selection.anchorOffset,
          focus: identity(selection.focusNode),
          focusOffset: selection.focusOffset,
          collapsed: selection.isCollapsed,
        },
      }
    }
    const record = (phase: string, event?: Event) => {
      if (events.length >= 1000) return
      events.push({
        phase,
        name: event?.type,
        target: identity(event?.target ?? null),
        trusted: event?.isTrusted,
        prevented: event?.defaultPrevented,
        ...(event instanceof KeyboardEvent
          ? {
              key: event.key,
              code: event.code,
              modifiers: {
                alt: event.altKey,
                ctrl: event.ctrlKey,
                meta: event.metaKey,
                shift: event.shiftKey,
              },
              repeat: event.repeat,
              composing: event.isComposing,
            }
          : {}),
        ...snapshot(),
      })
    }
    const removers: Array<() => void> = []
    for (const name of [
      'keydown',
      'keyup',
      'focusin',
      'focusout',
      'visibilitychange',
      'selectionchange',
      'scroll',
      'scrollend',
    ]) {
      for (const capture of [true, false]) {
        const listener = (event: Event) => {
          record(capture ? 'capture' : 'bubble', event)
          if (capture && event instanceof KeyboardEvent) {
            queueMicrotask(() => record('microtask', event))
          }
        }
        document.addEventListener(name, listener, { capture, passive: true })
        removers.push(() => document.removeEventListener(name, listener, capture))
      }
    }
    let frame = 0
    const sample = () => {
      const element = grid()
      frames.push({
        time: performance.timeOrigin + performance.now(),
        left: element?.scrollLeft,
        top: element?.scrollTop,
        width: element?.scrollWidth,
        client: element?.clientWidth,
        gridId: element ? ids.get(element) : null,
        focused: document.hasFocus(),
        visibility: document.visibilityState,
      })
      if (frames.length < 2000) frame = requestAnimationFrame(sample)
    }
    record('installed')
    frame = requestAnimationFrame(sample)
    ;(globalThis as typeof globalThis & { keyboardDiagnostic: () => unknown }).keyboardDiagnostic =
      () => {
        record('finished')
        cancelAnimationFrame(frame)
        for (const remove of removers) remove()
        return { events, frames }
      }
  })
  return async (info: TestInfo, failed: boolean) => {
    const observations = await Promise.allSettled([
      app.evaluate(() =>
        (
          globalThis as typeof globalThis & { keyboardDiagnostic: () => unknown }
        ).keyboardDiagnostic(),
      ),
      page.evaluate(() =>
        (
          globalThis as typeof globalThis & { keyboardDiagnostic: () => unknown }
        ).keyboardDiagnostic(),
      ),
    ])
    const path = info.outputPath('keyboard-diagnostics.json')
    await writeFile(
      path,
      JSON.stringify(
        {
          failed,
          repeatEachIndex: info.repeatEachIndex,
          host: {
            platform: process.platform,
            arch: process.arch,
            release: release(),
            node: process.version,
          },
          native: observations[0],
          renderer: observations[1],
        },
        (_, value: unknown) => (value instanceof Error ? String(value) : value),
        2,
      ),
    )
    await info.attach('keyboard-diagnostics', {
      path,
      contentType: 'application/json',
    })
    if (failed) {
      await Promise.allSettled([
        page
          .screenshot({ timeout: 2000 })
          .then((body) => info.attach('keyboard-failure', { body, contentType: 'image/png' })),
        page
          .content()
          .then((body) => info.attach('keyboard-failure-dom', { body, contentType: 'text/html' })),
      ])
    }
  }
}
