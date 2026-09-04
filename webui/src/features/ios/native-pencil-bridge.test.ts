import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { useBoardAppStore } from "@/features/board/harness/store/board-app-store"
import {
  configureNativePencil,
  initNativePencilBridge,
  requestNativePencilSync,
  subscribeNativePencilSnapshots,
  type NativePencilSnapshot,
} from "./native-pencil-bridge"


const snapshot = (): NativePencilSnapshot => ({
  kind: "dim0.native-pencil.snapshot",
  version: 1,
  sessionId: "ad7dbd1d-7235-49c9-854f-c00613504eae",
  contextId: "board:",
  camera: { x: 0, y: 0, zoom: 1 },
  strokes: [{
    id: "a".repeat(64),
    tool: "pen",
    color: "#1F1F24",
    width: 4,
    opacity: 1,
    points: [{ x: 10, y: 20, pressure: 0.4 }],
  }],
})


describe("native Pencil bridge", () => {
  let dispose: (() => void) | null = null

  beforeEach(() => {
    useBoardAppStore.setState({ tool: "select" })
  })

  afterEach(() => {
    dispose?.()
    dispose = null
    delete window.webkit
  })

  it("toggles the active board tool between eraser and ink", () => {
    dispose = initNativePencilBridge()
    const detail = { handled: false }
    window.dispatchEvent(new CustomEvent("dim0:native-pencil-double-tap", { detail }))
    expect(detail.handled).toBe(true)
    expect(useBoardAppStore.getState().tool).toBe("eraser")

    window.dispatchEvent(new CustomEvent("dim0:native-pencil-double-tap", { detail: { handled: false } }))
    expect(useBoardAppStore.getState().tool).toBe("ink")
  })

  it("posts viewport configuration and resolves explicit sync after an async snapshot is handled", async () => {
    const messages: unknown[] = []
    let finishHandling!: (handled: boolean) => void
    window.webkit = {
      messageHandlers: {
        dim0NativePencil: { postMessage: (message) => messages.push(message) },
      },
    }
    const configuration = {
      enabled: true,
      contextId: "board:",
      rect: { x: 1, y: 2, width: 300, height: 200 },
      passthroughRects: [
        { x: 20, y: 0, width: 200, height: 54 },
        { x: 98, y: 46, width: 44, height: 44 },
      ],
      color: "#FFFFFF",
      storedColor: "#1F1F24",
      width: 8,
      tool: "pen" as const,
      camera: { x: 10, y: 20, zoom: 2 },
    }

    expect(configureNativePencil(configuration)).toBe(true)
    dispose = subscribeNativePencilSnapshots(() => new Promise((resolve) => {
      finishHandling = resolve
    }))
    const sync = requestNativePencilSync()
    expect(messages).toEqual([
      { kind: "dim0.native-pencil.configure", version: 1, ...configuration },
      { kind: "dim0.native-pencil.sync", version: 1 },
    ])

    const valid = snapshot()
    window.dispatchEvent(new CustomEvent("dim0:native-pencil-snapshot", { detail: valid }))
    expect(valid.handled).toBeUndefined()
    finishHandling(true)
    await expect(sync).resolves.toEqual({ total: 1 })
    expect(valid.handled).toBe(true)
  })

  it("accepts only a valid complete snapshot", () => {
    dispose = subscribeNativePencilSnapshots(() => true)
    const valid = snapshot()
    window.dispatchEvent(new CustomEvent("dim0:native-pencil-snapshot", { detail: valid }))
    expect(valid.handled).toBe(true)

    const invalid = { ...snapshot(), version: 2, handled: false }
    window.dispatchEvent(new CustomEvent("dim0:native-pencil-snapshot", { detail: invalid }))
    expect(invalid.handled).toBe(false)
  })

  it("accepts and acknowledges an automatic per-stroke delta", () => {
    let receivedKind = ""
    const messages: unknown[] = []
    window.webkit = {
      messageHandlers: {
        dim0NativePencil: { postMessage: (message) => messages.push(message) },
      },
    }
    dispose = subscribeNativePencilSnapshots((message) => {
      receivedKind = message.kind
      return true
    })
    const delta = {
      ...snapshot(),
      kind: "dim0.native-pencil.delta",
      messageId: "965ddcad-785b-42f5-849a-32218af580f7",
      manual: false,
      strokes: [],
      removedStrokeIds: ["a".repeat(64)],
      total: 0,
      handled: false,
    }

    window.dispatchEvent(new CustomEvent("dim0:native-pencil-snapshot", { detail: delta }))

    expect(delta.handled).toBe(true)
    expect(receivedKind).toBe("dim0.native-pencil.delta")
    expect(messages).toEqual([{
      kind: "dim0.native-pencil.ack",
      version: 1,
      messageId: delta.messageId,
      handled: true,
    }])
  })

  it("resolves a manual delta only after durable handling and reports async failure", async () => {
    const messages: unknown[] = []
    let finishHandling!: (handled: boolean) => void
    window.webkit = {
      messageHandlers: {
        dim0NativePencil: { postMessage: (message) => messages.push(message) },
      },
    }
    dispose = subscribeNativePencilSnapshots(() => new Promise((resolve) => {
      finishHandling = resolve
    }))
    const sync = requestNativePencilSync()
    const delta = {
      ...snapshot(),
      kind: "dim0.native-pencil.delta",
      messageId: "bdc7f1b0-28cc-43cb-b600-bc7b59ec303e",
      manual: true,
      strokes: [],
      removedStrokeIds: [],
      total: 0,
      handled: false,
    }

    window.dispatchEvent(new CustomEvent("dim0:native-pencil-snapshot", { detail: delta }))
    expect(messages).toEqual([{ kind: "dim0.native-pencil.sync", version: 1 }])

    finishHandling(true)
    await expect(sync).resolves.toEqual({ total: 0 })
    expect(messages.at(-1)).toEqual({
      kind: "dim0.native-pencil.ack",
      version: 1,
      messageId: delta.messageId,
      handled: true,
    })

    dispose()
    dispose = subscribeNativePencilSnapshots(() => Promise.reject(new Error("save failed")))
    const failedDelta = { ...delta, messageId: "f51aadfd-e5e2-417c-b9b8-42c1cf38022f", manual: false }
    window.dispatchEvent(new CustomEvent("dim0:native-pencil-snapshot", { detail: failedDelta }))
    await Promise.resolve()
    expect(messages.at(-1)).toEqual({
      kind: "dim0.native-pencil.ack",
      version: 1,
      messageId: failedDelta.messageId,
      handled: false,
    })
  })
})
