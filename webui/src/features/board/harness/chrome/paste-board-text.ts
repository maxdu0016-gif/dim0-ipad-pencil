import { isCanvasHarnessClipboard, paste, type CanvasStore, type Vec2 } from "@canvas-harness/core"
import { createDefaultNote } from "@/features/board/types/note"
import { noteToNode } from "../convert/note-to-node"


/** Paste a copied canvas selection or external text at the menu's world position. */
export const pasteBoardText = async (
  store: CanvasStore, text: string, at: Vec2, boardId: string, rootId: string | null,
): Promise<void> => {
  if (!text.trim()) throw new Error("Clipboard is empty.")
  if (text.length > 2_000_000) throw new Error("Clipboard content is too large.")
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { /* ordinary text */ }
  if (isCanvasHarnessClipboard(parsed)) {
    if (parsed.nodes.some((node) => node.type === "folder" || node.type === "document")) {
      throw new Error("Import documents separately; copy a folder's contents instead.")
    }
    const scope = { graphUid: boardId, parentId: rootId ?? undefined }
    await paste(store, {
      ...parsed,
      nodes: parsed.nodes.map((node) => ({ ...node, data: { ...(typeof node.data === "object" ? node.data : {}), ...scope } })),
      edges: parsed.edges.map((edge) => ({ ...edge, data: { ...(typeof edge.data === "object" ? edge.data : {}), ...scope } })),
    }, { at })
    return
  }
  const note = createDefaultNote({ boardId, nodeType: "text" })
  note.content = { markdown: text }
  if (rootId) note.parentId = rootId
  note.properties.nodePosition = { type: "position", position: at }
  store.setSelection([store.addNode(noteToNode(note))])
}
