import { asBatchId, type CanvasStore, type Op, type OpBatch } from "@canvas-harness/core"
import { createBoardStore } from "../harness/store/create-board-store"
import { readContent } from "@/features/board/persist/local/codec"
import { applyContentToStore } from "@/features/board/persist/local/apply-content"
import { filterContentByLayer } from "@/features/board/model/layer"
import type { BoardContent } from "@/features/board/model"
import type { BoardPersistence } from "@/features/board/persist/local/board-persistence"
import type { StorageEngine } from "@/features/board/persist/local/engine"
import { attachBoardSync, type BoardSyncHandle } from "../harness/sync/board-sync"
import { createLanRelay, type LanExchange } from "../harness/sync/lan-relay"
import { normalizeInboundBatch } from "../harness/sync/inbound-normalize"
import { lanCommand, type LanBinding } from "./native"
import { BoardOutbox } from "@/features/board/persist/local/board-outbox"
import type { OplogRecord } from "@/features/board/persist/local/idb"


/** Mirror only the visible layer, preserving the user's undo history and private viewport. */
function project(full: CanvasStore, visible: CanvasStore, rootId: string | null): void {
  const content = filterContentByLayer(readContent(full), rootId)
  const nodes = new Map(content.nodes.map((n) => [n.id, n]))
  const edges = new Map(content.edges.map((e) => [e.id, e]))
  const ops: Op[] = []
  for (const edge of visible.getAllEdges()) if (!edges.has(edge.id)) ops.push({ type: "edge.remove", edge })
  for (const node of visible.getAllNodes()) if (!nodes.has(node.id)) ops.push({ type: "node.remove", node })
  for (const node of nodes.values()) {
    const prev = visible.getNode(node.id)
    if (!prev) ops.push({ type: "node.add", node })
    else if (JSON.stringify(prev) !== JSON.stringify(node)) ops.push({ type: "node.update", id: node.id, patch: node, prev })
  }
  for (const edge of edges.values()) {
    const prev = visible.getEdge(edge.id)
    if (!prev) ops.push({ type: "edge.add", edge })
    else if (JSON.stringify(prev) !== JSON.stringify(edge)) ops.push({ type: "edge.update", id: edge.id, patch: edge, prev })
  }
  const groups = new Set(content.groups.map((g) => g.id))
  for (const group of visible.getAllGroups()) if (!groups.has(group.id)) ops.push({ type: "group.remove", group })
  for (const group of content.groups) {
    const prev = visible.getAllGroups().find((g) => g.id === group.id)
    if (JSON.stringify(prev) !== JSON.stringify(group)) ops.push({ type: "group.upsert", group, prev })
  }
  const previousFrames = visible.getFrames().map((f) => f.id)
  const nextFrames = content.frameOrder ?? []
  if (JSON.stringify(previousFrames) !== JSON.stringify(nextFrames)) ops.push({ type: "frame.reorder", ids: nextFrames, prev: previousFrames })
  if (ops.length) visible.applyBatch({ id: asBatchId(crypto.randomUUID()), clientId: full.clientId, ts: Date.now(), origin: "remote", ops })
}


/** Reuse the existing merge coordinator on a whole-board store, even when viewing a subfolder. */
export async function attachLanBoard(opts: {
  boardId: string
  store: CanvasStore
  content: BoardContent
  persistence: BoardPersistence
  engine: StorageEngine
  rootId: string | null
  binding: LanBinding
  onState: (state: "connected" | "reconnecting", error?: string) => void
}): Promise<BoardSyncHandle> {
  const records = await opts.engine.list<OplogRecord>("oplog", { range: { lower: [opts.boardId, 0], upper: [opts.boardId, Number.MAX_SAFE_INTEGER] } })
  const pending = await new BoardOutbox(opts.engine, opts.boardId).pending()
  const full = createBoardStore({ clientId: opts.store.clientId })
  applyContentToStore(full, opts.content)
  const detachPersistence = opts.persistence.attach(full)
  const detachVisible = opts.store.subscribe("change", (batch) => {
    if (batch.origin !== "remote") full.applyBatch(batch)
  })
  const detachProjection = full.subscribe("change", () => project(full, opts.store, opts.rootId))
  const handle = attachBoardSync({
    store: full, persistence: opts.persistence, engine: opts.engine,
    boardId: opts.boardId, clientId: full.clientId,
    initialServerSeq: records.reduce((seq, record) => Math.max(seq, record.serverSeq ?? 0), 0),
    initialPending: pending.map((record) => record.batch),
    normalizeRemote: (batch: OpBatch) => normalizeInboundBatch(batch, full),
    connect: (sinceSeq) => createLanRelay({
      sinceSeq,
      exchange: async (since, messages) => {
        if (opts.binding.role === "host") await lanCommand("start", { address: opts.binding.address })
        return lanCommand<LanExchange>("exchange", { ...opts.binding, since, messages })
      },
      onState: opts.onState,
    }),
  })
  return {
    ...handle,
    // Off-scene edits join the whole-board store so they share persistence and rebase.
    submitLocalBatch: (batch) => full.applyBatch(batch),
    detach() {
      handle.detach()
      detachVisible()
      detachProjection()
      detachPersistence()
    },
  }
}
