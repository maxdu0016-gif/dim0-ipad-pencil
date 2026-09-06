import { expect, it, vi } from "vitest"
import { asNodeId } from "@canvas-harness/core"
import { addNode, freshStore } from "@/test/canvas"
import { InMemoryEngine } from "@/features/board/persist/local/in-memory-engine"
import { emptyContent, readContent } from "@/features/board/persist/local/codec"
import { newLocalBoard } from "@/features/board/persist/local/board-registry"
import { captureLanSeed, importLanSeed } from "./seed"


it("embeds available images and rejects missing bytes instead of reporting a complete offline package", async () => {
  const engine = new InMemoryEngine()
  const store = freshStore()
  addNode(store, "image")
  store.updateNode(asNodeId("image"), { data: { src: "https://example.com/image.png" } })
  const source = readContent(store)
  const fetcher = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(["image"], { type: "image/png" }) })
  vi.stubGlobal("fetch", fetcher)
  try {
    const seed = await captureLanSeed(engine, newLocalBoard("Images", 1), source, 0)
    expect(seed.content.nodes[0].data?.src).toMatch(/^data:image\/png;base64,/)
    expect(source.nodes[0].data?.src).toBe("https://example.com/image.png")
    fetcher.mockRejectedValue(new Error("Offline"))
    await expect(captureLanSeed(engine, newLocalBoard("Images", 1), source, 0)).rejects.toThrow("部分图片")
  } finally { vi.unstubAllGlobals() }
})


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
