import { expect, test } from "@playwright/test"


test("toolbar docks to a side and remembers the choice", async ({ page }) => {
  await page.addInitScript(() => {
    const host = window as typeof window & { __dim0NativeMessages: unknown[] }
    host.__DIM0_IOS_NATIVE__ = { version: 1, platform: "ipad" }
    host.__dim0NativeMessages = []
    host.webkit = {
      messageHandlers: {
        dim0NativePencil: {
          postMessage: (message: unknown) => host.__dim0NativeMessages.push(message),
        },
      },
    }
  })
  await page.goto("/local")
  await page.getByRole("list", { name: "On this device" }).getByText("New Board").click()
  await page.waitForURL(/\/local\/.+/)

  const toolbar = page.getByRole("toolbar", { name: "Board toolbar" })
  const dragHandle = page.getByRole("button", { name: /Move toolbar/ })
  await expect(toolbar).toHaveAttribute("data-toolbar-dock", "top")
  await expect(toolbar).toHaveAttribute("data-native-pencil-passthrough", "")
  await expect(dragHandle).toHaveAttribute("data-native-pencil-passthrough", "")

  const passthroughRects = async () => page.evaluate(() => {
    type Rect = { x: number; y: number; width: number; height: number }
    type ConfigureMessage = { kind?: string; passthroughRects?: Rect[] }
    const host = window as typeof window & { __dim0NativeMessages?: ConfigureMessage[] }
    return host.__dim0NativeMessages
      ?.filter((message) => message.kind === "dim0.native-pencil.configure")
      .at(-1)
      ?.passthroughRects ?? []
  })
  await expect.poll(async () => (await passthroughRects()).length).toBeGreaterThanOrEqual(2)
  await expect.poll(async () => (await passthroughRects()).some((rect) =>
    rect.width >= 44 && rect.height >= 44,
  )).toBe(true)

  const handleBox = await dragHandle.boundingBox()
  const viewport = page.viewportSize()
  expect(handleBox).not.toBeNull()
  expect(viewport).not.toBeNull()
  if (!handleBox || !viewport) return

  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(viewport.width - 20, viewport.height / 2, { steps: 8 })
  await page.mouse.up()

  await expect(toolbar).toHaveAttribute("data-toolbar-dock", "right")
  await expect(toolbar).toHaveAttribute("aria-orientation", "vertical")
  await expect.poll(() => page.evaluate(() =>
    localStorage.getItem("dim0.board_toolbar_dock"),
  )).toBe("right")
  await expect.poll(async () => (await passthroughRects()).some((rect) =>
    rect.x > viewport.width / 2,
  )).toBe(true)

  await page.getByRole("button", { name: "Change view" }).hover()
  await expect(page.locator('[data-slot="tooltip-content"]', { hasText: "Change view" }))
    .toHaveAttribute("data-side", "left")

  await page.reload()
  await expect(toolbar).toHaveAttribute("data-toolbar-dock", "right")
  await expect.poll(async () => (await passthroughRects()).some((rect) =>
    rect.x > viewport.width / 2,
  )).toBe(true)
})
