import { act, useRef } from "react"
import { createRoot } from "react-dom/client"
import { createCanvasStore } from "@canvas-harness/core"
import { expect, it, vi } from "vitest"
import { useNativePencilCanvas } from "./use-native-pencil-canvas"
import { configureNativePencil } from "./native-pencil-bridge"


vi.mock("@/platform", () => ({ isIOSNative: () => true }))
vi.mock("./native-pencil-bridge", () => ({
  configureNativePencil: vi.fn(),
  subscribeNativePencilSnapshots: () => () => {},
}))


it("releases Pencil touch interception while typing and restores it after focus leaves", () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previous = globals.IS_REACT_ACT_ENVIRONMENT
  globals.IS_REACT_ACT_ENVIRONMENT = true
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback))
  vi.stubGlobal("cancelAnimationFrame", () => {})
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} })
  const store = createCanvasStore()
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  function Harness() {
    const ref = useRef<HTMLDivElement>(null)
    useNativePencilCanvas({
      store, wrapRef: ref, boardId: "board", parentId: null, ready: true, canEdit: true,
      enabled: true, erasing: false, color: "#000000", displayColor: "#000000", size: 4,
    })
    return <div ref={ref}><textarea /></div>
  }
  const flush = (): void => { act(() => { frames.splice(0).forEach((callback) => callback(0)) }) }
  try {
    act(() => root.render(<Harness />))
    flush()
    expect(configureNativePencil).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }))
    const input = container.querySelector("textarea")!
    act(() => input.focus())
    flush()
    expect(configureNativePencil).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }))
    act(() => input.blur())
    flush()
    expect(configureNativePencil).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }))
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
    globals.IS_REACT_ACT_ENVIRONMENT = previous
  }
})
