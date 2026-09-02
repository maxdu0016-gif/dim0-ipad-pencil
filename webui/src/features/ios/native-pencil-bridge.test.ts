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

  it("posts viewport configuration and explicit sync separately", () => {
    const messages: unknown[] = []
    window.webkit = {
      messageHandlers: {
        dim0NativePencil: { postMessage: (message) => messages.push(message) },
      },
    }
    const configuration = {
      enabled: true,
      contextId: "board:",
      rect: { x: 1, y: 2, width: 300, height: 200 },
      color: "#FFFFFF",
      storedColor: "#1F1F24",
      width: 8,
      tool: "pen" as const,
      camera: { x: 10, y: 20, zoom: 2 },
    }

    expect(configureNativePencil(configuration)).toBe(true)
    expect(requestNativePencilSync()).toBe(true)
    expect(messages).toEqual([
      { kind: "dim0.native-pencil.configure", version: 1, ...configuration },
      { kind: "dim0.native-pencil.sync", version: 1 },
    ])
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
})
