/** Locks the native app's page scale; the canvas keeps its independent camera zoom. */
export const initNativeViewport = (): void => {
  let viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
  if (!viewport) {
    viewport = document.createElement("meta")
    viewport.name = "viewport"
    document.head.appendChild(viewport)
  }
  viewport.content = "width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"
}
