import { useLayoutEffect, useRef, type PointerEvent, type MouseEvent } from "react"
import { panByScreen, zoomAtScreenPoint, type CanvasStore } from "@canvas-harness/core"


type Contact = { x: number; y: number; type: string }


/** Own hand-tool gestures before node listeners; use the engine's camera math for pan and pinch. */
export function useHandPan(store: CanvasStore, enabled: boolean) {
  const contacts = useRef(new Map<number, Contact>())
  const capture = useRef<HTMLDivElement | null>(null)
  const host = useRef<HTMLElement | null>(null)

  useLayoutEffect(() => {
    if (!enabled) return
    const pointers = contacts.current
    return () => {
      for (const id of pointers.keys()) {
        if (capture.current?.hasPointerCapture(id)) capture.current.releasePointerCapture(id)
      }
      pointers.clear()
      if (store.getInteractionState().mode === "panning" || store.getInteractionState().mode === "zooming") {
        store.setInteractionState({ mode: "idle" })
      }
    }
  }, [enabled, store])

  const stop = (event: PointerEvent<HTMLDivElement> | MouseEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.stopPropagation()
  }
  const onPointerDownCapture = (event: PointerEvent<HTMLDivElement>): void => {
    if (!enabled || event.button !== 0) return
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-canvas-host]") : null
    if (!target) return
    stop(event)
    host.current = target
    capture.current = event.currentTarget
    // A resting palm must not turn a Pencil drag into a pinch.
    if (contacts.current.size && (event.pointerType !== "touch" || [...contacts.current.values()].some(p => p.type !== "touch"))) return
    contacts.current.set(event.pointerId, { x: event.clientX, y: event.clientY, type: event.pointerType })
    event.currentTarget.setPointerCapture(event.pointerId)
    store.setInteractionState({ mode: contacts.current.size === 1 ? "panning" : "zooming" })
  }
  const onPointerMoveCapture = (event: PointerEvent<HTMLDivElement>): void => {
    const previous = contacts.current.get(event.pointerId)
    if (!enabled || !previous) return
    stop(event)
    const next = { x: event.clientX, y: event.clientY, type: event.pointerType }
    contacts.current.set(event.pointerId, next)
    const camera = store.getCamera()
    if (contacts.current.size === 1) {
      store.setCamera(panByScreen(camera, { x: next.x - previous.x, y: next.y - previous.y }))
    } else if (contacts.current.size === 2 && host.current) {
      const other = [...contacts.current.entries()].find(([id]) => id !== event.pointerId)![1]
      const distance = Math.hypot(previous.x - other.x, previous.y - other.y)
      const nextDistance = Math.hypot(next.x - other.x, next.y - other.y)
      if (distance <= 0 || nextDistance <= 0) return
      const rect = host.current.getBoundingClientRect()
      const anchor = { x: (previous.x + other.x) / 2 - rect.left, y: (previous.y + other.y) / 2 - rect.top }
      const zoomed = zoomAtScreenPoint(camera, camera.z * nextDistance / distance, anchor)
      store.setCamera(panByScreen(zoomed, { x: (next.x - previous.x) / 2, y: (next.y - previous.y) / 2 }))
    }
  }
  const onPointerUpCapture = (event: PointerEvent<HTMLDivElement>): void => {
    if (!contacts.current.has(event.pointerId)) return
    if (event.type === "pointerup") onPointerMoveCapture(event)
    stop(event)
    contacts.current.delete(event.pointerId)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    store.setInteractionState({ mode: contacts.current.size === 0 ? "idle" : contacts.current.size === 1 ? "panning" : "zooming" })
  }
  const onClickCapture = (event: MouseEvent<HTMLDivElement>): void => {
    if (enabled && event.target instanceof Element && event.target.closest("[data-canvas-host]")) stop(event)
  }
  return { onPointerDownCapture, onPointerMoveCapture, onPointerUpCapture,
    onPointerCancelCapture: onPointerUpCapture, onLostPointerCapture: onPointerUpCapture,
    onClickCapture, onDoubleClickCapture: onClickCapture }
}
