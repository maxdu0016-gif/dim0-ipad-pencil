import { createCanvasStore, serializeSelection } from "@canvas-harness/core"
import { expect, it } from "vitest"
import { pasteBoardText } from "./paste-board-text"


it("pastes external text at the chosen position and copies notes without overwriting originals", async () => {
  const store = createCanvasStore()
  await pasteBoardText(store, "Meeting at 10:30", { x: 150, y: 250 }, "board1", null)
  const original = store.getAllNodes()[0]
  expect(original).toMatchObject({ x: 150, y: 250, content: "Meeting at 10:30" })
  const clip = JSON.stringify(serializeSelection(store))
  await pasteBoardText(store, clip, { x: 600, y: 700 }, "board2", "folder2")
  const nodes = store.getAllNodes()
  expect(nodes).toHaveLength(2)
  const copied = nodes.find((node) => node.id !== original.id)!
  expect(copied.x + copied.w / 2).toBe(600)
  expect(copied.data).toMatchObject({ graphUid: "board2", parentId: "folder2" })
  store.undo()
  expect(store.getAllNodes()).toHaveLength(1)
})


it("rejects empty content and document pointers that lack their stored text", async () => {
  const store = createCanvasStore()
  await expect(pasteBoardText(store, " ", { x: 0, y: 0 }, "board1", null)).rejects.toThrow("empty")
  const clip = JSON.stringify({ kind: "canvas-harness/clipboard", nodes: [{ type: "document" }], edges: [] })
  await expect(pasteBoardText(store, clip, { x: 0, y: 0 }, "board1", null)).rejects.toThrow("Import documents")
  expect(store.getAllNodes()).toHaveLength(0)
})
