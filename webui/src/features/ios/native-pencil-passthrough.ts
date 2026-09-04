import type { NativePencilRect } from "./native-pencil-bridge"


const PASSTHROUGH_PADDING = 8
const MAX_PASSTHROUGH_RECTS = 64


export const NATIVE_PENCIL_PASSTHROUGH_SELECTOR = [
  "[data-native-pencil-passthrough]",
  '[data-slot="dropdown-menu-content"]',
  '[data-slot="dropdown-menu-sub-content"]',
  '[data-slot="popover-content"]',
  '[data-slot="select-content"]',
  '[data-slot="dialog-overlay"]',
  '[data-slot="dialog-content"]',
  '[data-slot="alert-dialog-overlay"]',
  '[data-slot="alert-dialog-content"]',
  '[data-slot="sheet-overlay"]',
  '[data-slot="sheet-content"]',
  '[data-slot="context-menu-content"]',
  '[data-slot="context-menu-sub-content"]',
].join(",")


type ViewportSize = {
  width: number
  height: number
}


const finiteRect = (rect: DOMRect): boolean =>
  Number.isFinite(rect.left)
  && Number.isFinite(rect.top)
  && Number.isFinite(rect.right)
  && Number.isFinite(rect.bottom)


/** Collects padded viewport rectangles where the native Pencil overlay must yield to web chrome. */
export const collectNativePencilPassthroughRects = (
  root: ParentNode = document,
  viewport: ViewportSize = { width: window.innerWidth, height: window.innerHeight },
): NativePencilRect[] => Array.from(
  root.querySelectorAll<HTMLElement>(NATIVE_PENCIL_PASSTHROUGH_SELECTOR),
)
  .slice(0, MAX_PASSTHROUGH_RECTS)
  .map((element) => element.getBoundingClientRect())
  .filter((rect) => finiteRect(rect) && rect.width > 0 && rect.height > 0)
  .map((rect) => {
    const left = Math.max(0, rect.left - PASSTHROUGH_PADDING)
    const top = Math.max(0, rect.top - PASSTHROUGH_PADDING)
    const right = Math.min(viewport.width, rect.right + PASSTHROUGH_PADDING)
    const bottom = Math.min(viewport.height, rect.bottom + PASSTHROUGH_PADDING)
    return {
      x: left,
      y: top,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    }
  })
  .filter((rect) => rect.width > 0 && rect.height > 0)


/** Returns whether a body child-list mutation can change an interactive portal rectangle. */
export const mutationAffectsNativePencilPassthrough = (mutation: MutationRecord): boolean => {
  const target = mutation.target instanceof Element ? mutation.target : null
  if (target?.matches(NATIVE_PENCIL_PASSTHROUGH_SELECTOR)
      || target?.closest(NATIVE_PENCIL_PASSTHROUGH_SELECTOR)) {
    return true
  }

  return [...mutation.addedNodes, ...mutation.removedNodes].some((node) =>
    node instanceof Element
    && (node.matches(NATIVE_PENCIL_PASSTHROUGH_SELECTOR)
      || node.querySelector(NATIVE_PENCIL_PASSTHROUGH_SELECTOR) !== null),
  )
}
