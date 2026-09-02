import { z } from "zod"
import { useBoardAppStore } from "@/features/board/harness/store/board-app-store"


type NativePencilGestureDetail = {
  handled?: boolean
}


type NativeMessageHandler = {
  postMessage: (message: unknown) => void
}


declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        dim0NativePencil?: NativeMessageHandler
      }
    }
  }
}


const nativePencilStrokeSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/i),
  tool: z.enum(["pen", "highlighter"]),
  color: z.string().regex(/^#[a-f0-9]{6}$/i),
  width: z.number().finite().min(0.5).max(64),
  opacity: z.number().finite().min(0).max(1),
  points: z.array(z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    pressure: z.number().finite().min(0).max(1),
  }).strict()).min(1).max(50_000),
}).strict()


const nativePencilSnapshotSchema = z.object({
  kind: z.literal("dim0.native-pencil.snapshot"),
  version: z.literal(1),
  sessionId: z.string().uuid(),
  contextId: z.string().min(1).max(500),
  camera: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    zoom: z.number().finite().positive(),
  }).strict(),
  strokes: z.array(nativePencilStrokeSchema).max(20_000),
  handled: z.boolean().optional(),
}).strict()


export type NativePencilSnapshot = z.infer<typeof nativePencilSnapshotSchema>


export type NativePencilConfiguration = {
  enabled: boolean
  contextId: string
  rect: { x: number; y: number; width: number; height: number }
  color: string
  storedColor: string
  width: number
  tool: "pen" | "eraser"
  camera: { x: number; y: number; zoom: number }
}


/** Sends the current web canvas bounds and pen appearance to the native PencilKit overlay. */
export const configureNativePencil = (configuration: NativePencilConfiguration): boolean => {
  const handler = window.webkit?.messageHandlers?.dim0NativePencil
  if (!handler) return false

  handler.postMessage({
    kind: "dim0.native-pencil.configure",
    version: 1,
    ...configuration,
  })
  return true
}


/** Requests conversion of the complete local PencilKit document into the current web board. */
export const requestNativePencilSync = (): boolean => {
  const handler = window.webkit?.messageHandlers?.dim0NativePencil
  if (!handler) return false

  handler.postMessage({ kind: "dim0.native-pencil.sync", version: 1 })
  return true
}


/** Listens only for snapshots produced by an explicit native Sync action. */
export const subscribeNativePencilSnapshots = (
  onSnapshot: (snapshot: NativePencilSnapshot) => boolean,
): (() => void) => {
  const listener = (event: Event): void => {
    const customEvent = event as CustomEvent<unknown>
    const parsed = nativePencilSnapshotSchema.safeParse(customEvent.detail)
    if (!parsed.success) return

    const sourceDetail = customEvent.detail as NativePencilGestureDetail
    sourceDetail.handled = onSnapshot(parsed.data)
  }

  window.addEventListener("dim0:native-pencil-snapshot", listener)
  return () => window.removeEventListener("dim0:native-pencil-snapshot", listener)
}


/** Routes native Pencil gestures into the active canvas tool without touching ink Pointer Events. */
export const initNativePencilBridge = (): (() => void) => {
  const onDoubleTap = (event: Event): void => {
    const customEvent = event as CustomEvent<NativePencilGestureDetail>
    if (customEvent.detail) customEvent.detail.handled = true

    const board = useBoardAppStore.getState()
    board.setTool(board.tool === "eraser" ? "ink" : "eraser")
  }

  window.addEventListener("dim0:native-pencil-double-tap", onDoubleTap)
  return () => window.removeEventListener("dim0:native-pencil-double-tap", onDoubleTap)
}
