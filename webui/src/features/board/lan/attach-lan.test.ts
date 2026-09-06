import { afterEach, expect, it, vi } from "vitest"
import { asClientId, asNodeId, type OpBatch } from "@canvas-harness/core"
import { createBoardStore } from "../harness/store/create-board-store"
import { addNode, freshStore } from "@/test/canvas"
import { InMemoryEngine } from "@/features/board/persist/local/in-memory-engine"
import { BoardPersistence } from "@/features/board/persist/local/board-persistence"
import { applyContentToStore } from "@/features/board/persist/local/apply-content"
import { readContent } from "@/features/board/persist/local/codec"
import type { InboundMessage, OutboundMessage } from "../harness/sync/wire"
import { attachLanBoard } from "./attach-lan"
import { lanCommand } from "./native"


vi.mock("./native", () => ({ lanCommand: vi.fn() }))
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })


it("syncs across layers, propagates deletion and resumes without replaying old edits over confirmed state", async () => {
  vi.useFakeTimers()
  const base = freshStore()
  addNode(base, "root")
  addNode(base, "child")
  base.updateNode(asNodeId("child"), { data: { parentId: "folder" } })
  const content = readContent(base)
  const journal: OpBatch[] = []
  let online = true
  vi.mocked(lanCommand).mockImplementation(async (action, body) => {
    if (action === "start") return {} as never
    if (!online) throw new Error("Offline")
    const input = body as { clientId: string; since: number; messages: OutboundMessage[] }
    const acknowledgments: InboundMessage[] = []
    for (const msg of input.messages) {
      if (msg.kind !== "op") continue
      let index = journal.findIndex((batch) => batch.id === msg.batch.id)
      if (index < 0) { journal.push(structuredClone(msg.batch)); index = journal.length - 1 }
      acknowledgments.push({ kind: "op-applied", seq: index + 1, client_seq: msg.client_seq })
    }
    const messages: InboundMessage[] = journal.flatMap((batch, index) => index >= input.since && batch.clientId !== input.clientId
      ? [{ kind: "peer-op" as const, seq: index + 1, batch: structuredClone(batch) }] : [])
    messages.push(...acknowledgments)
    messages.sort((a, b) => ("seq" in a ? a.seq : 0) - ("seq" in b ? b.seq : 0))
    return { cursor: journal.length, latest: journal.length, messages } as never
  })
  const open = async (id: string, rootId: string | null, engine = new InMemoryEngine()) => {
    if (!await engine.get("snapshots", "board")) await engine.put("snapshots", { content, seq: 0 }, "board")
    const persistence = new BoardPersistence("board", { engine })
    const loaded = await persistence.load()
    const store = createBoardStore({ clientId: asClientId(id) })
    applyContentToStore(store, loaded, rootId)
    const handle = await attachLanBoard({ boardId: "board", store, content: loaded, persistence, engine, rootId,
      binding: { role: "host", room: "r", clientId: id, endpoint: "https://192.168.1.1:45678", address: "192.168.1.1" }, onState: vi.fn(),
    })
    return { handle, persistence, engine, store }
  }
  const desktop = await open("desktop", null)
  let ipad = await open("ipad", "folder")
  const tick = async () => {
    await vi.advanceTimersByTimeAsync(2400)
    await desktop.handle.settle()
    await ipad.handle.settle()
    await desktop.persistence.flush()
    await ipad.persistence.flush()
  }
  await tick()
  desktop.store.updateNode(asNodeId("root"), { x: 40 })
  ipad.store.updateNode(asNodeId("child"), { x: 80 })
  await tick()
  expect(desktop.store.getNode(asNodeId("child"))).toBeUndefined()
  expect(ipad.store.getNode(asNodeId("root"))).toBeUndefined()
  expect((await desktop.persistence.load()).nodes.find((n) => n.id === "child")?.x).toBe(80)
  online = false
  ipad.store.updateNode(asNodeId("child"), { x: 120 })
  await tick()
  ipad.handle.detach()
  await ipad.persistence.flush()
  ipad = await open("ipad", "folder", ipad.engine)
  online = true
  await tick()
  expect((await desktop.persistence.load()).nodes.find((n) => n.id === "child")?.x).toBe(120)
  ipad.store.removeNode(asNodeId("child"))
  await tick()
  expect((await desktop.persistence.load()).nodes.some((n) => n.id === "child")).toBe(false)
  ipad.store.undo()
  await tick()
  expect((await desktop.persistence.load()).nodes.find((n) => n.id === "child")?.x).toBe(120)
  desktop.handle.detach()
  ipad.handle.detach()
  desktop.persistence.close()
  ipad.persistence.close()
})
