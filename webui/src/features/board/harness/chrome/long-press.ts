/** Open a touch menu only for a stationary, single-finger hold; never for pen input. */
export const bindLongPress = (
  element: HTMLElement,
  open: (x: number, y: number) => void,
  allowed: (target: EventTarget | null) => boolean,
): (() => void) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  let start: { id: number; x: number; y: number } | undefined
  let opened = false
  let suppressClick = false
  const pointers = new Set<number>()
  const cancel = (): void => { clearTimeout(timer); timer = undefined; start = undefined }
  const down = (event: PointerEvent): void => {
    pointers.add(event.pointerId)
    cancel()
    opened = false
    if (pointers.size !== 1 || event.pointerType !== "touch" || !allowed(event.target)) return
    start = { id: event.pointerId, x: event.clientX, y: event.clientY }
    timer = setTimeout(() => {
      if (!start) return
      opened = true
      suppressClick = true
      open(start.x, start.y)
      cancel()
    }, 550)
  }
  const move = (event: PointerEvent): void => {
    if (start?.id === event.pointerId && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) cancel()
  }
  const up = (event: PointerEvent): void => {
    pointers.delete(event.pointerId)
    cancel()
    if (opened) {
      opened = false
      event.preventDefault()
      event.stopImmediatePropagation()
    }
  }
  const click = (event: MouseEvent): void => {
    if (!suppressClick) return
    suppressClick = false
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  const nextTouch = (): void => { suppressClick = false }
  window.addEventListener("pointerdown", nextTouch, true)
  element.addEventListener("pointerdown", down, true)
  window.addEventListener("pointermove", move, true)
  window.addEventListener("pointerup", up, true)
  window.addEventListener("pointercancel", up, true)
  window.addEventListener("click", click, true)
  return () => {
    cancel()
    element.removeEventListener("pointerdown", down, true)
    window.removeEventListener("pointermove", move, true)
    window.removeEventListener("pointerup", up, true)
    window.removeEventListener("pointercancel", up, true)
    window.removeEventListener("click", click, true)
    window.removeEventListener("pointerdown", nextTouch, true)
  }
}
