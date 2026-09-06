import { act, useRef } from "react"
import { createRoot } from "react-dom/client"
import { asNodeId, createCanvasStore } from "@canvas-harness/core"
import { expect, it } from "vitest"
import { useBoardAppStore } from "../store/board-app-store"
import { useTouchShapeEdit } from "./use-touch-shape-edit"
import { createHarnessTextareaEditor } from "./text-editor-adapter"


it("opens and focuses shape text on two touch taps, excluding drags, pinches, cancellation and read-only boards", () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previous = globals.IS_REACT_ACT_ENVIRONMENT
  globals.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  const store = createCanvasStore()
  const id = asNodeId("shape")
  store.addNode({ id, type: "rect", x: 0, y: 0, w: 100, h: 100, angle: 0, z: 0, groups: [], style: {}, content: "Hello" })
  useBoardAppStore.setState({ tool: "select", canEdit: true, viewMode: "board" })
  function Harness() {
    const ref = useRef<HTMLDivElement>(null)
    useTouchShapeEdit(ref, store)
    return <div ref={ref}><div data-canvas-host="" /></div>
  }
  try {
    act(() => root.render(<Harness />))
    const host = container.querySelector("[data-canvas-host]")!
    const send = (type: string, x = 50, isPrimary = true): void => {
      act(() => host.dispatchEvent(new PointerEvent(type, {
        bubbles: true, pointerType: "touch", isPrimary, pointerId: isPrimary ? 1 : 2, clientX: x, clientY: 50,
      })))
    }
    const tap = (): void => {
      send("pointerdown")
      send("pointerup")
    }
    for (const interrupted of ["pointermove", "pointercancel", "pinch"]) {
      tap()
      send("pointerdown")
      if (interrupted === "pinch") send("pointerdown", 60, false)
      else send(interrupted, 80)
      send("pointerup")
      tap()
      expect(store.getInteractionState().mode).not.toBe("editing")
      send("pointercancel")
    }
    useBoardAppStore.setState({ canEdit: false })
    tap()
    tap()
    expect(store.getInteractionState().mode).not.toBe("editing")
    useBoardAppStore.setState({ canEdit: true })
    tap()
    tap()
    expect(store.getInteractionState().editingTarget?.id).toBe(id)
    const adapter = createHarnessTextareaEditor({
      node: store.getNode(id)!, container, camera: store.getCamera(), dpr: 1,
      onCommit: (text) => store.commitEdit(text), onCancel: () => store.cancelEdit(),
    })
    const textarea = container.querySelector("textarea")!
    expect(document.activeElement).toBe(textarea)
    textarea.value = "Edited"
    textarea.dispatchEvent(new Event("blur"))
    expect(store.getNode(id)?.content).toBe("Edited")
    adapter.destroy()
  } finally {
    act(() => root.unmount())
    container.remove()
    globals.IS_REACT_ACT_ENVIRONMENT = previous
  }
})
