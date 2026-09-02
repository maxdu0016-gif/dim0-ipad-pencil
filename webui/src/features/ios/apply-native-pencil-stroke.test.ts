import { describe, expect, it } from "vitest"
import { readInkProperty } from "@/features/board/harness/ink/ink-geometry"
import { createBoardStore } from "@/features/board/harness/store/create-board-store"
import { applyNativePencilSnapshot } from "./apply-native-pencil-stroke"
import type { NativePencilSnapshot } from "./native-pencil-bridge"


const snapshot = (...ids: string[]): NativePencilSnapshot => ({
  kind: "dim0.native-pencil.snapshot",
  version: 1,
  sessionId: "ad7dbd1d-7235-49c9-854f-c00613504eae",
  contextId: "board:",
  camera: { x: 100, y: 50, zoom: 2 },
  strokes: ids.map((id, index) => ({
    id: id.repeat(64),
    tool: "pen",
    color: "#1F1F24",
    width: 8,
    opacity: 1,
    points: [
      { x: 120 + index, y: 70, pressure: 0.4 },
      { x: 140 + index, y: 90, pressure: 0.7 },
    ],
  })),
})


describe("applyNativePencilSnapshot", () => {
  it("converts the full screen-space snapshot in one batch", () => {
    const store = createBoardStore()
    store.setCamera({ x: 100, y: 50, z: 2 })
    const operationTypes: string[] = []
    store.subscribe("change", (batch) => operationTypes.push(...batch.ops.map((op) => op.type)))

    const result = applyNativePencilSnapshot(store, snapshot("a", "b"), "board", null)

    expect(result).toEqual({ handled: true, added: 2, removed: 0, total: 2 })
    expect(operationTypes.filter((type) => type === "node.add")).toHaveLength(2)
    const node = store.getAllNodes()[0]!
    const ink = readInkProperty(node)!
    expect(node.x + ink.points[0]![0]).toBeCloseTo(160)
    expect(node.y + ink.points[0]![1]).toBeCloseTo(85)
    expect(ink.size).toBe(4)
  })

  it("reconciles erased local strokes on the next manual sync", () => {
    const store = createBoardStore()
    applyNativePencilSnapshot(store, snapshot("a", "b"), "board", null)

    const result = applyNativePencilSnapshot(store, snapshot("b"), "board", null)

    expect(result).toEqual({ handled: true, added: 0, removed: 1, total: 1 })
    expect(store.getNodeCount()).toBe(1)
  })
})
