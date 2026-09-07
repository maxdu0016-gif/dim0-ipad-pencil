import { useEffect, type RefObject } from "react"
import { EDGE_HIT_SLOP_PX, hitTestAny, hitTestEdge, screenToWorld, type CanvasStore, type NodeId, type EdgeId } from "@canvas-harness/core"
import { useBoardAppStore } from "../store/board-app-store"
import { CUSTOM_NODE_TYPES } from "./custom-node-types"


/** Recognize touch double-taps because canvas pointer capture suppresses native dblclick on iPad. */
export function useTouchShapeEdit(wrapRef: RefObject<HTMLDivElement | null>, store: CanvasStore): void {
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    let down: { id: number; x: number; y: number; time: number; nodeId?: NodeId; edgeId?: EdgeId } | null = null
    let last: { nodeId: NodeId; time: number; x: number; y: number } | null = null

    const reset = (): void => {
      down = null
      last = null
    }
    const onDown = (e: PointerEvent): void => {
      const app = useBoardAppStore.getState()
      if (e.pointerType !== "touch" || !e.isPrimary || !app.canEdit || app.tool !== "select"
        || app.viewMode !== "board" || store.getInteractionState().mode === "editing") {
        reset()
        return
      }
      const host = e.target instanceof HTMLElement && e.target.matches("[data-canvas-host]") ? e.target : null
      if (!host) {
        reset()
        return
      }
      const rect = host.getBoundingClientRect()
      const camera = store.getCamera()
      const world = screenToWorld({ x: e.clientX - rect.left, y: e.clientY - rect.top }, camera)
      const hit = hitTestAny(store, world, camera.z)
      // Use the engine's curve geometry with a 44px touch target; nodes retain priority.
      const edge = !hit || "edgeId" in hit
        ? hitTestEdge(store, world, camera.z * EDGE_HIT_SLOP_PX / 22)
        : null
      if (edge) {
        down = { id: e.pointerId, x: e.clientX, y: e.clientY, time: e.timeStamp, edgeId: edge.edgeId }
        return
      }
      const node = hit?.kind === "body" && "nodeId" in hit ? store.getNode(hit.nodeId) : undefined
      if (!node || CUSTOM_NODE_TYPES.has(node.type)) {
        reset()
        return
      }
      down = { id: e.pointerId, x: e.clientX, y: e.clientY, time: e.timeStamp, nodeId: node.id }
    }
    const onMove = (e: PointerEvent): void => {
      if (down && e.pointerId === down.id && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) reset()
    }
    const onUp = (e: PointerEvent): void => {
      const tap = down
      down = null
      if (!tap || e.pointerId !== tap.id || e.timeStamp - tap.time > 300
        || Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 8) {
        last = null
        return
      }
      if (tap.edgeId) {
        last = null
        store.setSelection([tap.edgeId])
        return
      }
      if (!tap.nodeId) return
      if (last?.nodeId === tap.nodeId && e.timeStamp - last.time < 400
        && Math.hypot(e.clientX - last.x, e.clientY - last.y) <= 16) {
        last = null
        store.beginEdit(tap.nodeId)
      } else {
        last = { nodeId: tap.nodeId, time: e.timeStamp, x: e.clientX, y: e.clientY }
      }
    }

    wrap.addEventListener("pointerdown", onDown)
    wrap.addEventListener("pointermove", onMove)
    wrap.addEventListener("pointerup", onUp)
    wrap.addEventListener("pointercancel", reset)
    return () => {
      wrap.removeEventListener("pointerdown", onDown)
      wrap.removeEventListener("pointermove", onMove)
      wrap.removeEventListener("pointerup", onUp)
      wrap.removeEventListener("pointercancel", reset)
    }
  }, [wrapRef, store])
}
