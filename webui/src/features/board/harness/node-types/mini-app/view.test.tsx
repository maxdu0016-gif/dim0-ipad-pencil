import { act, useEffect } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"
import { asNodeId } from "@canvas-harness/core"
import { MiniAppView } from "./view"


const state = vi.hoisted(() => ({
  node: { id: "app", type: "mini-app", x: 0, y: 0, w: 720, h: 440, content: "source", data: {} },
  updateNode: vi.fn(),
}))


vi.mock("@canvas-harness/react", () => ({
  useNode: () => state.node,
  useSelection: () => [],
  useCanvasStore: () => ({ getNode: () => state.node, updateNode: state.updateNode }),
}))
vi.mock("@/features/board/harness/graph/subtree", () => ({ removeNodeSubtree: vi.fn() }))
vi.mock("@phosphor-icons/react", () => ({ CursorClickIcon: () => null }))
vi.mock("../../store/board-app-store", () => ({
  useBoardAppStore: (select: (s: { canEdit: boolean; openNodeSurface: () => void }) => unknown) =>
    select({ canEdit: true, openNodeSurface: vi.fn() }),
}))
vi.mock("../../shared-views", () => ({
  createDeferredMount: () => () => ({ shouldMount: true, isInView: true }),
  NodeTitleCaption: () => null,
  NodeTrafficLights: () => null,
}))
vi.mock("@/features/mini-app", () => ({
  prefetchMiniAppRuntime: vi.fn(),
  MiniAppMount: ({ onContentHeightChange }: { onContentHeightChange?: (height: number) => void }) => {
    useEffect(() => { onContentHeightChange?.(1000) }, [onContentHeightChange])
    return null
  },
}))


afterEach(() => vi.clearAllMocks())


it("keeps the canvas footprint when loaded mini-app content is taller than its card", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  const container = document.createElement("div")
  const root = createRoot(container)
  try {
    await act(async () => { root.render(<MiniAppView id={asNodeId("app")} />) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
    // Content below the 440px card must remain visible; the iframe scrolls instead.
    expect(state.updateNode).not.toHaveBeenCalled()
  } finally {
    await act(async () => root.unmount())
    vi.unstubAllGlobals()
  }
})
