import { useEffect, useRef } from 'react'

export const sidebarWidthKey = 'duckit.sidebarWidth'
export const defaultSidebarWidth = 320
export const minimumSidebarWidth = 240
export const maximumSidebarWidth = 480
export const stackedSidebarBreakpoint = 720

export function sidebarPreference(value: string | null): number {
  const width = value === null || value.trim() === '' ? NaN : Number(value)
  return Number.isFinite(width)
    ? Math.min(maximumSidebarWidth, Math.max(minimumSidebarWidth, width))
    : defaultSidebarWidth
}

export function sidebarWidth(width: number, viewportWidth: number): number {
  return Math.min(Math.max(minimumSidebarWidth, width), maximumSidebarWidth, viewportWidth * 0.4)
}

/** Resizing only changes a CSS variable; it never rerenders the ledger or its balances. */
export function useSidebarWidth() {
  const shellRef = useRef<HTMLDivElement>(null)
  const dividerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const shell = shellRef.current
    const divider = dividerRef.current
    if (!shell || !divider) return
    let preferred = defaultSidebarWidth
    try {
      preferred = sidebarPreference(localStorage.getItem(sidebarWidthKey))
    } catch {
      // Local preferences must never prevent opening the workspace.
    }
    let frame = 0
    let drag: { pointerId: number; startX: number; startWidth: number } | undefined
    const describeWidth = () => {
      divider.setAttribute(
        'aria-valuenow',
        String(Math.round(sidebarWidth(preferred, window.innerWidth))),
      )
      divider.setAttribute(
        'aria-valuemax',
        String(Math.min(maximumSidebarWidth, window.innerWidth * 0.4)),
      )
    }
    const paint = () => {
      frame = 0
      shell.style.setProperty('--sidebar-width', `${preferred}px`)
      describeWidth()
    }
    const save = () => {
      try {
        localStorage.setItem(sidebarWidthKey, String(preferred))
      } catch {
        // Keep the session's width when local storage is unavailable.
      }
    }
    const finish = () => {
      if (!drag) return
      const pointerId = drag.pointerId
      drag = undefined
      if (divider.hasPointerCapture(pointerId)) divider.releasePointerCapture(pointerId)
      shell.classList.remove('is-resizing-sidebar')
      cancelAnimationFrame(frame)
      paint()
      save()
    }
    const move = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return
      if (window.innerWidth <= stackedSidebarBreakpoint) {
        finish()
        return
      }
      preferred = sidebarWidth(drag.startWidth + event.clientX - drag.startX, window.innerWidth)
      if (!frame) frame = requestAnimationFrame(paint)
    }
    const start = (event: PointerEvent) => {
      if (event.button !== 0 || window.innerWidth <= stackedSidebarBreakpoint) return
      event.preventDefault()
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: sidebarWidth(preferred, window.innerWidth),
      }
      divider.setPointerCapture(event.pointerId)
      shell.classList.add('is-resizing-sidebar')
    }
    const reset = () => {
      if (window.innerWidth <= stackedSidebarBreakpoint) return
      preferred = defaultSidebarWidth
      paint()
      save()
    }
    const keydown = (event: KeyboardEvent) => {
      if (window.innerWidth <= stackedSidebarBreakpoint) return
      if (event.key === 'Home') reset()
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        preferred = sidebarWidth(
          sidebarWidth(preferred, window.innerWidth) + (event.key === 'ArrowLeft' ? -10 : 10),
          window.innerWidth,
        )
        paint()
        save()
      } else return
      event.preventDefault()
    }
    paint()
    divider.addEventListener('pointerdown', start)
    divider.addEventListener('pointermove', move)
    divider.addEventListener('pointerup', finish)
    divider.addEventListener('pointercancel', finish)
    divider.addEventListener('lostpointercapture', finish)
    divider.addEventListener('dblclick', reset)
    divider.addEventListener('keydown', keydown)
    window.addEventListener('resize', describeWidth)
    return () => {
      cancelAnimationFrame(frame)
      divider.removeEventListener('pointerdown', start)
      divider.removeEventListener('pointermove', move)
      divider.removeEventListener('pointerup', finish)
      divider.removeEventListener('pointercancel', finish)
      divider.removeEventListener('lostpointercapture', finish)
      divider.removeEventListener('dblclick', reset)
      divider.removeEventListener('keydown', keydown)
      window.removeEventListener('resize', describeWidth)
    }
  }, [])

  return { shellRef, dividerRef }
}
