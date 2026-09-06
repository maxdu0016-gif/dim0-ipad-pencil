import { expect, it } from "vitest"
import { InMemoryEngine } from "@/features/board/persist/local/in-memory-engine"
import { emptyContent } from "@/features/board/persist/local/codec"
import { newLocalBoard } from "@/features/board/persist/local/board-registry"
import { captureLanSeed, importLanSeed } from "./seed"


it("imports attachments atomically and never overwrites an independent board", async () => {
  const host = new InMemoryEngine()
  const peer = new InMemoryEngine()
  const meta = newLocalBoard("Shared", 1)
  const document = { id: "doc", boardId: meta.id, title: "Reference", pages: 1, createdAt: 1 }
  const chunk = { chunkId: "chunk", boardId: meta.id, docId: "doc", index: 0, text: "Offline document" }
  await host.put("documents", document)
  await host.put("chunks", chunk)
  const seed = await captureLanSeed(host, meta, emptyContent(), 3)
  await peer.put("boards", { ...meta, title: "My original" })
  await expect(importLanSeed(peer, seed, "room")).rejects.toThrow("独立画布")
  expect(await peer.list("documents")).toEqual([])
  await peer.delete("boards", meta.id)
  await importLanSeed(peer, seed, "room")
  expect(await peer.get("chunks", "chunk")).toEqual(chunk)
  const changed = { ...seed.content, frameOrder: [] }
  await peer.put("snapshots", { content: changed, seq: 9 }, meta.id)
  await importLanSeed(peer, seed, "room")
  expect(await peer.get("snapshots", meta.id)).toEqual({ content: changed, seq: 9 })
})


it("rolls back the whole import if an attachment would overwrite another board's data", async () => {
  const engine = new InMemoryEngine()
  const meta = newLocalBoard("Shared", 1)
  const seed = await captureLanSeed(engine, meta, emptyContent(), 0)
  seed.documents = [{ id: "doc", boardId: meta.id, title: "D", pages: 1, createdAt: 0 }]
  seed.chunks = [{ chunkId: "collision", boardId: meta.id, docId: "doc", index: 0, text: "new" }]
  await engine.put("chunks", { chunkId: "collision", boardId: "other", docId: "other", text: "original" })
  await expect(importLanSeed(engine, seed, "room")).rejects.toThrow("附件 ID")
  expect(await engine.get("boards", meta.id)).toBeUndefined()
  expect(await engine.list("documents")).toEqual([])
  expect((await engine.get<{ text: string }>("chunks", "collision"))?.text).toBe("original")
})
