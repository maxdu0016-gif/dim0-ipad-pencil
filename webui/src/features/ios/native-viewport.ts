let removeViewportListeners: (() => void) | undefined


/** Locks page scale and tracks keyboard-safe height without scrolling the app. */
export const initNativeViewport = (): void => {
  let viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
  if (!viewport) {
    viewport = document.createElement("meta")
    viewport.name = "viewport"
    document.head.appendChild(viewport)
  }
  viewport.content = "width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"
  // Keep the app origin fixed as the keyboard changes its usable height.
  // Individual chat/editor panes retain their own scrolling.
  const update = (): void => {
    const visual = window.visualViewport
    document.documentElement.style.setProperty("--native-viewport-height", `${visual?.height ?? window.innerHeight}px`)
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0)
  }
  removeViewportListeners?.()
  const visual = window.visualViewport
  visual?.addEventListener("resize", update)
  visual?.addEventListener("scroll", update)
  window.addEventListener("resize", update)
  removeViewportListeners = () => {
    visual?.removeEventListener("resize", update)
    visual?.removeEventListener("scroll", update)
    window.removeEventListener("resize", update)
  }
  update()
}
