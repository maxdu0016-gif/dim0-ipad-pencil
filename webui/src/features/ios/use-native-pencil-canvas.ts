import { useEffect, type RefObject } from "react"
import type { CanvasStore } from "@canvas-harness/core"
import { getBoardPersistenceRef } from "@/features/board/persist/local/board-persistence-ref"
import { getBoardSyncRef } from "@/features/board/harness/sync/board-sync-ref"
import { isIOSNative } from "@/platform"
import { TOOLBAR_DOCK_CHANGE_EVENT } from "@/features/board/harness/chrome/toolbar-dock"
import { applyNativePencilSnapshot } from "./apply-native-pencil-stroke"
import { configureNativePencil, subscribeNativePencilSnapshots } from "./native-pencil-bridge"
import {
  collectNativePencilPassthroughRects,
  mutationAffectsNativePencilPassthrough,
} from "./native-pencil-passthrough"


export type NativePencilCanvasOptions = {
  store: CanvasStore
  wrapRef: RefObject<HTMLElement | null>
  boardId: string | null
  parentId: string | null
  ready: boolean
  canEdit: boolean
  enabled: boolean
  erasing: boolean
  color: string
  displayColor: string
  size: number
}


/** Binds the native PencilKit overlay to the active canvas and its formal node store. */
export const useNativePencilCanvas = ({
  store,
  wrapRef,
  boardId,
  parentId,
  ready,
  canEdit,
  enabled,
  erasing,
  color,
  displayColor,
  size,
}: NativePencilCanvasOptions): void => {
  const contextId = boardId ? `${boardId}:${parentId ?? ""}` : "unscoped"

  useEffect(() => {
    if (!isIOSNative()) return

    return subscribeNativePencilSnapshots(async (message) => {
      if (!ready || !canEdit || !boardId || message.contextId !== contextId) return false
      const result = applyNativePencilSnapshot(store, message, boardId, parentId)
      if (!result.handled) return false

      const sync = getBoardSyncRef()
      if (sync) await sync.settle()
      else {
        const persistence = getBoardPersistenceRef()
        if (!persistence) return false
        await persistence.flush()
      }
      return true
    })
  }, [store, boardId, parentId, contextId, ready, canEdit])

  useEffect(() => {
    if (!isIOSNative()) return

    const element = wrapRef.current
    let animationFrame = 0
    const sendConfiguration = (): void => {
      if (!element) return
      const rect = element.getBoundingClientRect()
      const camera = store.getCamera()
      configureNativePencil({
        enabled: enabled && ready && canEdit,
        contextId,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        passthroughRects: collectNativePencilPassthroughRects(),
        color: displayColor,
        storedColor: color,
        width: size * store.getCamera().z,
        tool: erasing ? "eraser" : "pen",
        camera: { x: camera.x, y: camera.y, zoom: camera.z },
      })
    }
    const scheduleConfiguration = (): void => {
      cancelAnimationFrame(animationFrame)
      animationFrame = requestAnimationFrame(sendConfiguration)
    }

    const resizeObserver = new ResizeObserver(scheduleConfiguration)
    if (element) resizeObserver.observe(element)
    const portalObserver = new MutationObserver((mutations) => {
      if (mutations.some(mutationAffectsNativePencilPassthrough)) scheduleConfiguration()
    })
    if (document.body) portalObserver.observe(document.body, { childList: true, subtree: true })
    const unsubscribeCamera = store.subscribe("camera", scheduleConfiguration)
    window.addEventListener("resize", scheduleConfiguration)
    window.addEventListener("scroll", scheduleConfiguration, true)
    window.addEventListener(TOOLBAR_DOCK_CHANGE_EVENT, scheduleConfiguration)
    scheduleConfiguration()

    return () => {
      cancelAnimationFrame(animationFrame)
      resizeObserver.disconnect()
      portalObserver.disconnect()
      unsubscribeCamera()
      window.removeEventListener("resize", scheduleConfiguration)
      window.removeEventListener("scroll", scheduleConfiguration, true)
      window.removeEventListener(TOOLBAR_DOCK_CHANGE_EVENT, scheduleConfiguration)

      const rect = element?.getBoundingClientRect()
      const camera = store.getCamera()
      configureNativePencil({
        enabled: false,
        contextId,
        rect: rect
          ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          : { x: 0, y: 0, width: 0, height: 0 },
        passthroughRects: [],
        color: displayColor,
        storedColor: color,
        width: size * store.getCamera().z,
        tool: erasing ? "eraser" : "pen",
        camera: { x: camera.x, y: camera.y, zoom: camera.z },
      })
    }
  }, [store, wrapRef, contextId, ready, canEdit, enabled, erasing, color, displayColor, size])
}
