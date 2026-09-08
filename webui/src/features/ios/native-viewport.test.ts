import { expect, it, vi } from "vitest"
import { initNativeViewport } from "./native-viewport"


it("locks page scale once even when the native bootstrap runs before the viewport meta exists", () => {
  document.head.querySelectorAll('meta[name="viewport"]').forEach((element) => element.remove())
  initNativeViewport()
  initNativeViewport()
  const metas = document.head.querySelectorAll<HTMLMetaElement>('meta[name="viewport"]')
  expect(metas).toHaveLength(1)
  expect(metas[0].content).toContain("minimum-scale=1, maximum-scale=1, user-scalable=no")
  expect(metas[0].content).toContain("viewport-fit=cover")
  metas[0].remove()
})


it("resizes usable height for keyboard and restores it when the keyboard closes", () => {
  const visual = new EventTarget() as EventTarget & { height: number }
  visual.height = 1000
  vi.stubGlobal("visualViewport", visual)
  try {
    initNativeViewport()
    visual.height = 550
    visual.dispatchEvent(new Event("resize"))
    expect(document.documentElement.style.getPropertyValue("--native-viewport-height")).toBe("550px")
    visual.height = 1000
    visual.dispatchEvent(new Event("resize"))
    expect(document.documentElement.style.getPropertyValue("--native-viewport-height")).toBe("1000px")
  } finally {
    vi.unstubAllGlobals()
  }
})
