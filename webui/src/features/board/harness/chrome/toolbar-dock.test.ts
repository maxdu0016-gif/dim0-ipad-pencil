import { beforeEach, describe, expect, it } from "vitest"

import {
  nearestToolbarDock,
  readToolbarDock,
  writeToolbarDock,
  type ToolbarDock,
  type ToolbarDockBounds,
} from "./toolbar-dock"


describe("nearestToolbarDock", () => {
  const bounds: ToolbarDockBounds = { left: 100, top: 50, width: 1000 }

  it.each([
    [{ x: 600, y: 70 }, "top"],
    [{ x: 120, y: 450 }, "left"],
    [{ x: 1080, y: 450 }, "right"],
    [{ x: 110, y: 60 }, "top"],
    [{ x: 600, y: 700 }, "left"],
  ] satisfies ReadonlyArray<[{ x: number; y: number }, ToolbarDock]>) (
    "chooses the nearest supported edge for %o",
    (point, expected) => {
      expect(nearestToolbarDock(point, bounds)).toBe(expected)
    },
  )
})


describe("toolbar dock storage", () => {
  beforeEach(() => window.localStorage.clear())

  it("round-trips a valid preference", () => {
    writeToolbarDock("right", window.localStorage)

    expect(readToolbarDock(window.localStorage)).toBe("right")
  })

  it("falls back to top for invalid or unavailable storage", () => {
    window.localStorage.setItem("dim0.board_toolbar_dock", "bottom")

    expect(readToolbarDock(window.localStorage)).toBe("top")
    expect(readToolbarDock(null)).toBe("top")
  })

  it("does not fail when storage access is rejected", () => {
    const rejectedStorage = {
      getItem: () => { throw new Error("blocked") },
      setItem: () => { throw new Error("blocked") },
    }

    expect(readToolbarDock(rejectedStorage)).toBe("top")
    expect(() => writeToolbarDock("left", rejectedStorage)).not.toThrow()
  })
})
