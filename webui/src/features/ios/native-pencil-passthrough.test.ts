import { describe, expect, it } from "vitest"
import {
  collectNativePencilPassthroughRects,
  mutationAffectsNativePencilPassthrough,
} from "./native-pencil-passthrough"


const setRect = (
  element: HTMLElement,
  { left, top, width, height }: { left: number; top: number; width: number; height: number },
): void => {
  element.getBoundingClientRect = () => ({
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  })
}


const childListMutation = (
  target: Node,
  addedNodes: Node[] = [],
  removedNodes: Node[] = [],
): MutationRecord => ({ target, addedNodes, removedNodes }) as unknown as MutationRecord


describe("native Pencil passthrough rectangles", () => {
  it("leaves chat input, replies and visible controls reachable even after many hidden controls", () => {
    const root = document.createElement("div")
    for (let index = 0; index < 64; index++) {
      const hidden = document.createElement("div")
      hidden.dataset.nativePencilPassthrough = ""
      root.append(hidden)
    }
    const composer = document.createElement("div")
    composer.dataset.coachmark = "ai-island"
    const reply = document.createElement("div")
    reply.dataset.answerCard = ""
    root.append(composer, reply)
    setRect(composer, { left: 100, top: 600, width: 400, height: 80 })
    setRect(reply, { left: 600, top: 80, width: 200, height: 300 })
    expect(collectNativePencilPassthroughRects(root, { width: 1000, height: 800 })).toEqual([
      { x: 92, y: 592, width: 416, height: 96 },
      { x: 592, y: 72, width: 216, height: 316 },
    ])
  })

  it("collects the tray and its outside drag handle as separate padded rectangles", () => {
    const root = document.createElement("div")
    const toolbar = document.createElement("div")
    const handle = document.createElement("button")
    toolbar.dataset.nativePencilPassthrough = ""
    handle.dataset.nativePencilPassthrough = ""
    toolbar.append(handle)
    root.append(toolbar)
    setRect(toolbar, { left: 20, top: 0, width: 200, height: 46 })
    setRect(handle, { left: 98, top: 46, width: 44, height: 44 })

    expect(collectNativePencilPassthroughRects(root, { width: 300, height: 200 })).toEqual([
      { x: 12, y: 0, width: 216, height: 54 },
      { x: 90, y: 38, width: 60, height: 60 },
    ])
  })

  it("clips rectangles to the viewport and removes empty or invalid entries", () => {
    const root = document.createElement("div")
    const visible = document.createElement("div")
    const empty = document.createElement("div")
    const invalid = document.createElement("div")
    for (const element of [visible, empty, invalid]) {
      element.dataset.nativePencilPassthrough = ""
      root.append(element)
    }
    setRect(visible, { left: 280, top: 180, width: 40, height: 40 })
    setRect(empty, { left: 1, top: 1, width: 0, height: 10 })
    setRect(invalid, { left: Number.NaN, top: 1, width: 10, height: 10 })

    expect(collectNativePencilPassthroughRects(root, { width: 300, height: 200 })).toEqual([
      { x: 272, y: 172, width: 28, height: 28 },
    ])
  })

  it("reacts only to mutations that add, remove, or resize passthrough portal content", () => {
    const root = document.createElement("div")
    const portal = document.createElement("div")
    portal.dataset.slot = "popover-content"
    const ordinary = document.createElement("span")
    root.append(portal)

    expect(mutationAffectsNativePencilPassthrough(childListMutation(root, [portal]))).toBe(true)
    expect(mutationAffectsNativePencilPassthrough(childListMutation(portal, [ordinary]))).toBe(true)
    expect(mutationAffectsNativePencilPassthrough(childListMutation(root, [ordinary]))).toBe(false)
  })
})
