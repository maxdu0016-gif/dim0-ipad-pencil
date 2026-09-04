import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { asEdgeId, createCanvasStore, type CanvasStore, type EdgeId } from "@canvas-harness/core"
import { CanvasProvider } from "@canvas-harness/react"

import { useBoardAppStore } from "../store/board-app-store"
import { HarnessToolbar } from "./toolbar"


vi.mock("@/platform", () => ({
  isIOSNative: () => false,
  isWebKitWebview: () => false,
}))

vi.mock("./toolbar-more", () => ({
  HarnessToolbarMore: () => null,
}))


const reactTestGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}


/** No-op observer used because jsdom does not implement layout resize events. */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}


/** Creates the direct-pointer event used by iPad Pencil and touch input. */
function directPointerEvent(
  type: "pointercancel" | "pointerdown" | "pointerup",
  pointerType: "pen" | "touch",
): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    button: 0,
    cancelable: true,
    isPrimary: true,
    pointerId: 1,
    pointerType,
  })
}


describe("HarnessToolbar direct pointer selection", () => {
  let container: HTMLDivElement
  let root: Root
  let store: CanvasStore
  let originalActEnvironment: boolean | undefined
  let originalResizeObserver: typeof ResizeObserver

  beforeEach(() => {
    originalActEnvironment = reactTestGlobal.IS_REACT_ACT_ENVIRONMENT
    reactTestGlobal.IS_REACT_ACT_ENVIRONMENT = true
    originalResizeObserver = globalThis.ResizeObserver
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
    useBoardAppStore.setState({ canEdit: true, tool: "select", viewMode: "board", chromeDialog: null })
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    store = createCanvasStore()
    act(() => root.render(
      <CanvasProvider store={store}>
        <HarnessToolbar />
      </CanvasProvider>,
    ))
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    reactTestGlobal.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment
    globalThis.ResizeObserver = originalResizeObserver
  })

  it("selects on Pencil contact but waits for a completed touch tap", () => {
    const pan = container.querySelector<HTMLButtonElement>('button[aria-label="Pan"]')
    expect(pan).not.toBeNull()
    if (!pan) return

    act(() => pan.dispatchEvent(directPointerEvent("pointerdown", "pen")))
    expect(useBoardAppStore.getState().tool).toBe("pan")

    act(() => useBoardAppStore.setState({ tool: "select" }))
    act(() => pan.dispatchEvent(directPointerEvent("pointerdown", "touch")))
    expect(useBoardAppStore.getState().tool).toBe("select")

    act(() => pan.dispatchEvent(directPointerEvent("pointerup", "touch")))
    expect(useBoardAppStore.getState().tool).toBe("pan")

    act(() => useBoardAppStore.setState({ tool: "select" }))
    act(() => pan.click())
    expect(useBoardAppStore.getState().tool).toBe("pan")
  })

  it("does not select when a touch becomes a side-palette scroll", () => {
    const pan = container.querySelector<HTMLButtonElement>('button[aria-label="Pan"]')
    expect(pan).not.toBeNull()
    if (!pan) return

    act(() => pan.dispatchEvent(directPointerEvent("pointerdown", "touch")))
    act(() => pan.dispatchEvent(directPointerEvent("pointercancel", "touch")))

    expect(useBoardAppStore.getState().tool).toBe("select")
  })

  it("offers a touch-sized delete action for a selected connector", () => {
    const edgeIds = [asEdgeId(store.generateId()), asEdgeId(store.generateId())]
    act(() => {
      for (const [index, id] of edgeIds.entries()) {
        store.addEdge({
          id,
          source: { worldPoint: { x: 0, y: index * 20 } },
          target: { worldPoint: { x: 100, y: index * 20 } },
          pathStyle: "straight",
          groups: [],
          style: {},
          data: {},
        })
      }
      store.setSelection(edgeIds)
    })

    const remove = container.querySelector<HTMLButtonElement>('button[aria-label="Delete selected connectors"]')
    expect(remove?.className).toContain("min-h-11")
    expect(remove?.className).toContain("min-w-11")
    if (!remove) return

    act(() => remove.click())

    expect(edgeIds.every((id: EdgeId) => store.getEdge(id) === undefined)).toBe(true)
    expect(store.getSelection()).toEqual([])

    act(() => {
      store.undo()
    })
    expect(edgeIds.every((id: EdgeId) => store.getEdge(id) !== undefined)).toBe(true)
  })

  it("keeps every primary tool target at least 44 CSS pixels wide and tall", () => {
    const labels = ["Change view", "Pan", "Select", "Pen", "Eraser", "Add shape", "Connector", "Text", "Note", "Slides"]

    for (const label of labels) {
      const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
      expect(button?.className).toContain("min-h-11")
      expect(button?.className).toContain("min-w-11")
    }

    const pen = container.querySelector<HTMLButtonElement>('button[aria-label="Pen"]')
    if (!pen) return
    act(() => pen.dispatchEvent(directPointerEvent("pointerdown", "pen")))

    const settings = container.querySelector<HTMLButtonElement>('button[aria-label="Pen settings"]')
    expect(settings?.className).toContain("size-11")
  })
})
