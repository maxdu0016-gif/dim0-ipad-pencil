import { act } from "react"
import { createRoot } from "react-dom/client"
import { asNodeId, createCanvasStore } from "@canvas-harness/core"
import { expect, it, vi } from "vitest"
import { useHandPan } from "./use-hand-pan"


it("pans over objects without selecting, preserves pinch and returns input to Select", () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previous = globals.IS_REACT_ACT_ENVIRONMENT
  globals.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  const store = createCanvasStore()
  const id = asNodeId("object")
  store.addNode({ id, type: "rect", x: 0, y: 0, w: 100, h: 100, angle: 0, z: 0, groups: [], style: {} })
  const objectDown = vi.fn(() => store.setSelection([id]))
  const objectClick = vi.fn()
  const toolbarClick = vi.fn()
  function Harness({ enabled }: { enabled: boolean }) {
    const handlers = useHandPan(store, enabled)
    return <div {...handlers}><div data-canvas-host=""><button onClick={objectClick}>Object</button></div><button data-toolbar="" onClick={toolbarClick}>Toolbar</button></div>
  }
  try {
    act(() => root.render(<Harness enabled />))
    const wrap = container.firstElementChild as HTMLDivElement
    const object = container.querySelector("[data-canvas-host] button")!
    object.addEventListener("pointerdown", objectDown)
    const captured = new Set<number>()
    wrap.setPointerCapture = id => { captured.add(id) }
    wrap.hasPointerCapture = id => captured.has(id)
    wrap.releasePointerCapture = id => { captured.delete(id) }
    const send = (type: string, x: number, pointerId = 1, pointerType = "touch"): void => {
      act(() => object.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType, pointerId, button: 0, clientX: x, clientY: 50 })))
    }
    for (const pointer of ["touch", "pen", "mouse"]) {
      store.setCamera({ x: 0, y: 0, z: 1 })
      send("pointerdown", 10, 1, pointer)
      send("pointermove", 50, 1, pointer)
      send("pointerup", 60, 1, pointer)
      expect(store.getCamera()).toEqual({ x: -50, y: 0, z: 1 })
      expect(store.getSelection()).toEqual([])
      expect(store.getNode(id)?.x).toBe(0)
      expect(store.getInteractionState().mode).toBe("idle")
    }
    expect(objectDown).not.toHaveBeenCalled()
    act(() => object.dispatchEvent(new MouseEvent("click", { bubbles: true })))
    expect(objectClick).not.toHaveBeenCalled()
    act(() => container.querySelector<HTMLButtonElement>("[data-toolbar]")!.click())
    expect(toolbarClick).toHaveBeenCalledOnce()

    store.setCamera({ x: 0, y: 0, z: 1 })
    send("pointerdown", 0)
    send("pointerdown", 100, 2)
    send("pointermove", 200, 2)
    expect(store.getCamera().z).toBe(2)
    send("pointercancel", 200, 2)
    send("pointermove", 20)
    expect(store.getCamera().x).toBe(-10)
    act(() => root.render(<Harness enabled={false} />))
    expect(captured.size).toBe(0)
    expect(store.getInteractionState().mode).toBe("idle")
    send("pointerdown", 20)
    expect(store.getSelection()).toEqual([id])
    act(() => object.dispatchEvent(new MouseEvent("click", { bubbles: true })))
    expect(objectClick).toHaveBeenCalledOnce()
  } finally {
    act(() => root.unmount())
    container.remove()
    globals.IS_REACT_ACT_ENVIRONMENT = previous
  }
})
