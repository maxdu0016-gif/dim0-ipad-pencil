import { expect, it, vi } from "vitest"
import { bindLongPress } from "./long-press"


/** Dispatch touch/pen pointer events without relying on jsdom PointerEvent support. */
const pointer = (target: EventTarget, type: string, id = 1, x = 20, pointerType = "touch"): void => {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, { pointerId: id, clientX: x, clientY: 30, pointerType })
  target.dispatchEvent(event)
}


it("opens once after a finger hold and leaves later menu clicks usable", () => {
  vi.useFakeTimers()
  const wrap = document.createElement("div")
  document.body.appendChild(wrap)
  const open = vi.fn()
  const stop = bindLongPress(wrap, open, () => true)
  try {
    pointer(wrap, "pointerdown")
    vi.advanceTimersByTime(550)
    expect(open).toHaveBeenCalledExactlyOnceWith(20, 30)
    pointer(window, "pointerup")
    const click = new Event("click", { cancelable: true })
    window.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    pointer(document.body, "pointerdown")
    const menuClick = new Event("click", { cancelable: true })
    window.dispatchEvent(menuClick)
    expect(menuClick.defaultPrevented).toBe(false)
  } finally { stop(); wrap.remove(); vi.useRealTimers() }
})


it("cancels holds for movement, multiple fingers, pen, controls and unmount", () => {
  vi.useFakeTimers()
  const wrap = document.createElement("div")
  document.body.appendChild(wrap)
  const open = vi.fn()
  const allowed = vi.fn(() => true)
  const stop = bindLongPress(wrap, open, allowed)
  try {
    pointer(wrap, "pointerdown")
    pointer(wrap, "pointermove", 1, 40)
    vi.advanceTimersByTime(600)
    pointer(window, "pointerup")
    pointer(wrap, "pointerdown")
    pointer(wrap, "pointerdown", 2)
    vi.advanceTimersByTime(600)
    pointer(window, "pointerup", 1)
    pointer(window, "pointerup", 2)
    pointer(wrap, "pointerdown", 1, 20, "pen")
    vi.advanceTimersByTime(600)
    pointer(window, "pointerup")
    allowed.mockReturnValue(false)
    pointer(wrap, "pointerdown")
    vi.advanceTimersByTime(600)
    pointer(window, "pointerup")
    allowed.mockReturnValue(true)
    pointer(wrap, "pointerdown")
    stop()
    vi.advanceTimersByTime(600)
    expect(open).not.toHaveBeenCalled()
  } finally { stop(); wrap.remove(); vi.useRealTimers() }
})
