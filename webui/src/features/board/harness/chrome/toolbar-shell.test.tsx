import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { DockableToolbarTray } from "./toolbar-shell"


const reactTestGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}


/** No-op observer used because jsdom does not implement layout resize events. */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}


/** Creates a pointer event with the identity fields used by pointer capture. */
function pointerEvent(
  type: string,
  { id, primary = true, x, y }: { id: number; primary?: boolean; x: number; y: number },
): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    button: 0,
    cancelable: true,
    clientX: x,
    clientY: y,
    isPrimary: primary,
    pointerId: id,
  })
}


describe("DockableToolbarTray pointer dragging", () => {
  let container: HTMLDivElement
  let root: Root
  let originalActEnvironment: boolean | undefined
  let originalResizeObserver: typeof ResizeObserver

  beforeEach(() => {
    originalActEnvironment = reactTestGlobal.IS_REACT_ACT_ENVIRONMENT
    reactTestGlobal.IS_REACT_ACT_ENVIRONMENT = true
    originalResizeObserver = globalThis.ResizeObserver
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    reactTestGlobal.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment
    globalThis.ResizeObserver = originalResizeObserver
  })

  it("ignores foreign pointers and completes the captured primary drag", () => {
    const onDockChange = vi.fn()
    act(() => {
      root.render(
        <DockableToolbarTray dock="top" onDockChange={onDockChange}>
          <span>Tools</span>
        </DockableToolbarTray>,
      )
    })

    const handle = container.querySelector<HTMLButtonElement>('button[aria-label^="Move toolbar"]')
    expect(handle).not.toBeNull()
    if (!handle) return

    const setPointerCapture = vi.fn()
    const releasePointerCapture = vi.fn()
    handle.setPointerCapture = setPointerCapture
    handle.hasPointerCapture = () => true
    handle.releasePointerCapture = releasePointerCapture

    act(() => handle.dispatchEvent(pointerEvent("pointerdown", { id: 1, x: 500, y: 20 })))
    act(() => handle.dispatchEvent(pointerEvent("pointerup", { id: 2, x: 10, y: 400 })))
    expect(onDockChange).not.toHaveBeenCalled()

    act(() => handle.dispatchEvent(pointerEvent("pointerup", { id: 1, x: 10, y: 400 })))
    expect(setPointerCapture).toHaveBeenCalledWith(1)
    expect(releasePointerCapture).toHaveBeenCalledWith(1)
    expect(onDockChange).toHaveBeenCalledWith("left")
  })

  it("clears a drag when pointer capture is lost", () => {
    act(() => {
      root.render(
        <DockableToolbarTray dock="top" onDockChange={() => {}}>
          <span>Tools</span>
        </DockableToolbarTray>,
      )
    })

    const toolbar = container.querySelector<HTMLElement>("[data-toolbar-dock]")
    const handle = container.querySelector<HTMLButtonElement>('button[aria-label^="Move toolbar"]')
    expect(toolbar).not.toBeNull()
    expect(handle).not.toBeNull()
    if (!toolbar || !handle) return

    handle.setPointerCapture = () => {}
    act(() => handle.dispatchEvent(pointerEvent("pointerdown", { id: 7, x: 500, y: 20 })))
    act(() => handle.dispatchEvent(pointerEvent("pointermove", { id: 7, x: 600, y: 120 })))
    expect(toolbar.firstElementChild?.getAttribute("style")).toContain("translate3d")

    act(() => handle.dispatchEvent(pointerEvent("lostpointercapture", { id: 7, x: 600, y: 120 })))
    expect((toolbar.firstElementChild as HTMLElement | null)?.style.transform).toBe("")
  })

  it("isolates tool presses from canvas ancestors while preserving the button event", () => {
    const onCanvasPointerDown = vi.fn()
    const onToolPointerDown = vi.fn()
    act(() => {
      root.render(
        <div onPointerDown={onCanvasPointerDown}>
          <DockableToolbarTray dock="left" onDockChange={() => {}}>
            <button type="button" onPointerDown={onToolPointerDown}>Pen</button>
          </DockableToolbarTray>
        </div>,
      )
    })

    const tool = container.querySelector<HTMLButtonElement>("button:not([data-toolbar-drag-handle])")
    const scrollArea = container.querySelector<HTMLElement>("[data-toolbar-dock] [class*='overflow-y-auto']")
    expect(tool).not.toBeNull()
    expect(scrollArea?.className).toContain("touch-pan-y")
    if (!tool) return

    act(() => tool.dispatchEvent(pointerEvent("pointerdown", { id: 9, x: 20, y: 100 })))

    expect(onToolPointerDown).toHaveBeenCalledOnce()
    expect(onCanvasPointerDown).not.toHaveBeenCalled()
  })
})
