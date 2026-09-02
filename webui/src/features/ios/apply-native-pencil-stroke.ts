import { asNodeId, screenToWorld, type CanvasStore, type Node } from "@canvas-harness/core"
import { v5 as uuidv5 } from "uuid"
import type { TextProperty } from "@/features/newsfeed/types/properties"
import type { NoteNodeData } from "@/features/board/harness/convert/note-to-node"
import { createInkNode } from "@/features/board/harness/ink/ink-geometry"
import { adaptNodeColors } from "@/features/board/harness/theme/color-adapter"
import { getBoardThemeMode } from "@/features/board/harness/theme/theme-mode-ref"
import type { NativePencilSnapshot } from "./native-pencil-bridge"


const NATIVE_INK_NAMESPACE = "cc744ebb-ea24-5f52-b4a2-bf521678c772"

type NativeInkSource = {
  sessionId: string
  contextId: string
  strokeId: string
}

type RelayProperties = Partial<NoteNodeData["properties"]> & {
  nativeInkSource?: TextProperty
  native_ink_source?: TextProperty
}


const nodeIdFor = (snapshot: NativePencilSnapshot, strokeId: string): string =>
  uuidv5(`${snapshot.sessionId}:${strokeId}`, NATIVE_INK_NAMESPACE)


const sourceProperty = (source: NativeInkSource): TextProperty => ({
  type: "text",
  text: JSON.stringify(source),
})


const readSource = (node: Node): NativeInkSource | null => {
  const data = (node.data ?? {}) as Partial<NoteNodeData>
  const properties = (data.properties ?? {}) as RelayProperties
  const raw = properties.nativeInkSource ?? properties.native_ink_source
  if (raw?.type !== "text" || !raw.text) return null

  try {
    const parsed = JSON.parse(raw.text) as Partial<NativeInkSource>
    return typeof parsed.sessionId === "string"
      && typeof parsed.contextId === "string"
      && typeof parsed.strokeId === "string"
      ? { sessionId: parsed.sessionId, contextId: parsed.contextId, strokeId: parsed.strokeId }
      : null
  } catch {
    return null
  }
}


const createNativeInkNode = (
  snapshot: NativePencilSnapshot,
  stroke: NativePencilSnapshot["strokes"][number],
  boardId: string,
  parentId: string | null,
): (Omit<Node, "z"> & { z?: number }) | null => {
  const camera = { x: snapshot.camera.x, y: snapshot.camera.y, z: snapshot.camera.zoom }
  const displayColor = getBoardThemeMode() === "dark"
    ? (adaptNodeColors({ strokeColor: stroke.color }, "dark").strokeColor ?? stroke.color)
    : stroke.color
  const node = createInkNode({
    id: nodeIdFor(snapshot, stroke.id),
    boardId,
    parentId,
    color: stroke.color,
    displayColor,
    size: stroke.width / camera.z,
    samples: stroke.points.map((point) => ({
      ...screenToWorld({ x: point.x, y: point.y }, camera),
      pressure: point.pressure,
    })),
  })
  if (!node) return null

  const data = node.data as NoteNodeData
  return {
    ...node,
    style: { ...node.style, opacity: Math.round(stroke.opacity * 100) },
    data: {
      ...data,
      properties: {
        ...data.properties,
        nativeInkSource: sourceProperty({
          sessionId: snapshot.sessionId,
          contextId: snapshot.contextId,
          strokeId: stroke.id,
        }),
      },
    },
  }
}


export type ApplyNativePencilSnapshotResult = {
  handled: boolean
  added: number
  removed: number
  total: number
}


/** Reconciles one complete local PencilKit document as one undoable board mutation. */
export const applyNativePencilSnapshot = (
  store: CanvasStore,
  snapshot: NativePencilSnapshot,
  boardId: string,
  parentId: string | null,
): ApplyNativePencilSnapshotResult => {
  const incomingStrokeIds = new Set(snapshot.strokes.map((stroke) => stroke.id))
  const existing = new Map<string, Node>()

  for (const node of store.getAllNodes()) {
    const source = readSource(node)
    if (source?.sessionId === snapshot.sessionId && source.contextId === snapshot.contextId) {
      existing.set(source.strokeId, node)
    }
  }

  const stale = [...existing.entries()]
    .filter(([strokeId]) => !incomingStrokeIds.has(strokeId))
    .map(([, node]) => node)
  const missing = snapshot.strokes
    .filter((stroke) => !existing.has(stroke.id))
    .filter((stroke) => !store.getNode(asNodeId(nodeIdFor(snapshot, stroke.id))))
    .map((stroke) => createNativeInkNode(snapshot, stroke, boardId, parentId))
    .filter((node): node is Omit<Node, "z"> & { z?: number } => node !== null)

  if (stale.length > 0 || missing.length > 0) {
    store.batch(() => {
      for (const node of stale) store.removeNode(asNodeId(node.id))
      for (const node of missing) store.addNode(node)
    })
  }

  return {
    handled: true,
    added: missing.length,
    removed: stale.length,
    total: snapshot.strokes.length,
  }
}
