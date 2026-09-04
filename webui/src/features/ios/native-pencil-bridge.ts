import { z } from "zod"
import { useBoardAppStore } from "@/features/board/harness/store/board-app-store"


type NativePencilGestureDetail = {
  handled?: boolean
}


type NativeMessageHandler = {
  postMessage: (message: unknown) => void
}


export type NativePencilSyncResult = {
  total: number
}


type PendingNativePencilSync = {
  resolve: (result: NativePencilSyncResult) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}


let pendingSync: PendingNativePencilSync | null = null


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


const nativePencilCameraSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  zoom: z.number().finite().positive(),
}).strict()


const nativePencilSnapshotSchema = z.object({
  kind: z.literal("dim0.native-pencil.snapshot"),
  version: z.literal(1),
  sessionId: z.string().uuid(),
  contextId: z.string().min(1).max(500),
  camera: nativePencilCameraSchema,
  strokes: z.array(nativePencilStrokeSchema).max(20_000),
  handled: z.boolean().optional(),
}).strict()


export type NativePencilSnapshot = z.infer<typeof nativePencilSnapshotSchema>


const nativePencilDeltaSchema = z.object({
  kind: z.literal("dim0.native-pencil.delta"),
  version: z.literal(1),
  messageId: z.string().uuid(),
  manual: z.boolean(),
  sessionId: z.string().uuid(),
  contextId: z.string().min(1).max(500),
  camera: nativePencilCameraSchema,
  strokes: z.array(nativePencilStrokeSchema).max(20_000),
  removedStrokeIds: z.array(z.string().regex(/^[a-f0-9]{64}$/i)).max(20_000),
  total: z.number().int().nonnegative().max(1_000_000),
  handled: z.boolean().optional(),
}).strict()


const nativePencilMessageSchema = z.discriminatedUnion("kind", [
  nativePencilSnapshotSchema,
  nativePencilDeltaSchema,
])


export type NativePencilMessage = z.infer<typeof nativePencilMessageSchema>


export type NativePencilRect = {
  x: number
  y: number
  width: number
  height: number
}


export type NativePencilConfiguration = {
  enabled: boolean
  contextId: string
  rect: NativePencilRect
  passthroughRects: NativePencilRect[]
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


/** Requests one native snapshot and resolves after the active canvas accepts it. */
export const requestNativePencilSync = (): Promise<NativePencilSyncResult> => {
  const handler = window.webkit?.messageHandlers?.dim0NativePencil
  if (!handler) return Promise.reject(new Error("Native handwriting is unavailable."))
  if (pendingSync) return Promise.reject(new Error("Handwriting sync is already running."))

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingSync = null
      reject(new Error("Handwriting sync timed out."))
    }, 30_000)
    pendingSync = { resolve, reject, timeout }

    try {
      handler.postMessage({ kind: "dim0.native-pencil.sync", version: 1 })
    } catch (error) {
      clearTimeout(timeout)
      pendingSync = null
      reject(error instanceof Error ? error : new Error("Handwriting sync failed."))
    }
  })
}


/** Listens for explicit snapshots and automatic per-stroke PencilKit updates. */
export const subscribeNativePencilSnapshots = (
  onSnapshot: (snapshot: NativePencilMessage) => boolean | Promise<boolean>,
): (() => void) => {
  const listener = (event: Event): void => {
    const customEvent = event as CustomEvent<unknown>
    const parsed = nativePencilMessageSchema.safeParse(customEvent.detail)
    if (!parsed.success) return

    const sourceDetail = customEvent.detail as NativePencilGestureDetail
    const complete = (handled: boolean): void => {
      sourceDetail.handled = handled

      if (parsed.data.kind === "dim0.native-pencil.delta") {
        try {
          window.webkit?.messageHandlers?.dim0NativePencil?.postMessage({
            kind: "dim0.native-pencil.ack",
            version: 1,
            messageId: parsed.data.messageId,
            handled,
          })
        } catch {
          // Native will retain the pending strokes and retry if the ACK cannot be delivered.
        }
      }

      const isManualResponse = parsed.data.kind === "dim0.native-pencil.snapshot" || parsed.data.manual
      if (handled && pendingSync && isManualResponse) {
        const request = pendingSync
        pendingSync = null
        clearTimeout(request.timeout)
        request.resolve({
          total: parsed.data.kind === "dim0.native-pencil.snapshot"
            ? parsed.data.strokes.length
            : parsed.data.total,
        })
      }
    }

    try {
      const handled = onSnapshot(parsed.data)
      if (typeof handled === "boolean") complete(handled)
      else void handled.then(complete, () => complete(false)).catch(() => {})
    } catch {
      complete(false)
    }
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
