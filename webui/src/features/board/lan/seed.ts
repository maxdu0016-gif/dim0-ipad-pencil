import type { BoardContent, BoardMeta } from "@/features/board/model"
import type { StorageEngine } from "@/features/board/persist/local/engine"
import type { ChunkRecord, DocumentRecord } from "@/features/board/persist/local/idb"
import { blobToDataUrl } from "@/features/board/local/save-local-thumbnail"


export type LanSeed = {
  version: 1
  sourceSeq: number
  boardId: string
  title: string
  content: BoardContent
  documents: DocumentRecord[]
  chunks: ChunkRecord[]
  widgets: { noteId: string; state: unknown }[]
}


/** Copy only this board's content and attachments, never account settings or chat history. */
export async function captureLanSeed(engine: StorageEngine, meta: BoardMeta, content: BoardContent, sourceSeq: number): Promise<LanSeed> {
  const portable = structuredClone(content)
  for (const node of portable.nodes) {
    const data = node.data
    const src = data?.src
    if (!data || !src || src.startsWith("data:")) continue
    if (!/^(https?:|blob:)/i.test(src)) throw new Error("画布包含无法离线携带的图片，请重新导入该图片。")
    try {
      const response = await fetch(src, { credentials: "omit", cache: "force-cache", signal: AbortSignal.timeout(15000) })
      if (!response.ok) throw new Error("Missing image")
      const blob = await response.blob()
      if (!blob.type.startsWith("image/") || blob.size > 8 * 1024 * 1024) throw new Error("Invalid image")
      node.data = { ...data, src: await blobToDataUrl(blob) }
    } catch { throw new Error("部分图片尚未保存在本机，请联网加载或重新导入后再配对。") }
  }
  const query = { index: "by-board", range: { lower: meta.id, upper: meta.id } }
  const documents = await engine.list<DocumentRecord>("documents", query)
  const chunks = await engine.list<ChunkRecord>("chunks", query)
  const widgets = []
  for (const node of content.nodes) {
    const state = await engine.get<{ noteId: string; state: unknown }>("mini_app_state", node.id)
    if (state) widgets.push(state)
  }
  return { version: 1, sourceSeq, boardId: meta.id, title: meta.title, content: portable, documents, chunks, widgets }
}


/** Import atomically; an existing independent board must never be replaced by pairing. */
export async function importLanSeed(engine: StorageEngine, seed: LanSeed, room: string): Promise<void> {
  if (seed.version !== 1 || typeof seed.boardId !== "string" || !seed.boardId || typeof seed.title !== "string"
    || !Array.isArray(seed.content?.nodes) || !Array.isArray(seed.content?.edges) || !Array.isArray(seed.content?.groups)
    || !Array.isArray(seed.documents) || !Array.isArray(seed.chunks) || !Array.isArray(seed.widgets)) throw new Error("画布数据格式无效")
  const nodeIds = new Set(seed.content.nodes.map((node) => node.id as string))
  const docs = new Set(seed.documents.map((doc) => doc.id))
  if (seed.documents.some((doc) => doc.boardId !== seed.boardId || typeof doc.id !== "string")
    || seed.chunks.some((chunk) => chunk.boardId !== seed.boardId || !docs.has(chunk.docId) || typeof chunk.chunkId !== "string")
    || seed.widgets.some((widget) => !nodeIds.has(widget.noteId))) throw new Error("附件不属于当前画布")
  await engine.tx(["boards", "snapshots", "documents", "chunks", "mini_app_state"], async (tx) => {
    const existing = await tx.get<BoardMeta>("boards", seed.boardId)
    if (existing) {
      if (existing.lanRoom === room && !existing.deletedAt) return
      throw new Error("此设备已有同 ID 的独立画布，已取消导入以保护原有内容。")
    }
    for (const doc of seed.documents) {
      if (await tx.get("documents", doc.id)) throw new Error("文档 ID 已存在，已取消导入")
      await tx.put("documents", doc)
    }
    for (const chunk of seed.chunks) {
      if (await tx.get("chunks", chunk.chunkId)) throw new Error("附件 ID 已存在，已取消导入")
      await tx.put("chunks", chunk)
    }
    for (const widget of seed.widgets) {
      if (await tx.get("mini_app_state", widget.noteId)) throw new Error("组件 ID 已存在，已取消导入")
      await tx.put("mini_app_state", widget)
    }
    const now = Date.now()
    await tx.put<BoardMeta>("boards", { id: seed.boardId, title: seed.title, kind: "local-only", visibility: "private", lanRoom: room, createdAt: now, updatedAt: now })
    await tx.put("snapshots", { content: seed.content, seq: 0 }, seed.boardId)
  })
}
