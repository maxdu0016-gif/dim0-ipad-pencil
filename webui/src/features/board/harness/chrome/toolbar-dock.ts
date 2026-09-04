export type ToolbarDock = "top" | "left" | "right"


export type ToolbarDockBounds = {
  left: number
  top: number
  width: number
}


export const TOOLBAR_DOCK_CHANGE_EVENT = "dim0:board-toolbar-dock-change"


const TOOLBAR_DOCK_STORAGE_KEY = "dim0.board_toolbar_dock"


/** Resolves a pointer position to the nearest supported toolbar edge. */
export function nearestToolbarDock(
  point: { x: number; y: number },
  bounds: ToolbarDockBounds,
): ToolbarDock {
  const localX = point.x - bounds.left
  const localY = point.y - bounds.top
  const distances: ReadonlyArray<{ dock: ToolbarDock; distance: number }> = [
    { dock: "top", distance: localY },
    { dock: "left", distance: localX },
    { dock: "right", distance: bounds.width - localX },
  ]

  return distances.reduce((nearest, candidate) =>
    candidate.distance < nearest.distance ? candidate : nearest,
  ).dock
}


/** Reads the last valid dock preference, falling back safely when storage is unavailable. */
export function readToolbarDock(storage?: Pick<Storage, "getItem"> | null): ToolbarDock {
  try {
    const target = storage === undefined
      ? typeof window === "undefined" ? null : window.localStorage
      : storage
    const stored = target?.getItem(TOOLBAR_DOCK_STORAGE_KEY)
    return stored === "left" || stored === "right" || stored === "top" ? stored : "top"
  } catch {
    return "top"
  }
}


/** Persists a dock preference without making toolbar movement depend on storage access. */
export function writeToolbarDock(
  dock: ToolbarDock,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  try {
    const target = storage === undefined
      ? typeof window === "undefined" ? null : window.localStorage
      : storage
    target?.setItem(TOOLBAR_DOCK_STORAGE_KEY, dock)
  } catch {
    // Private browsing and locked-down webviews may reject local storage.
  }
}
