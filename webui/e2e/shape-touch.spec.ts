import { expect, test } from "@playwright/test"


test.use({ hasTouch: true, viewport: { width: 1194, height: 834 } })


test("draw, double-tap, edit and delete a shape with touch", async ({ page }) => {
  page.on("pageerror", (error) => console.log(error.message))
  await page.goto("/local")
  await page.getByRole("list", { name: "On this device" }).getByText("New Board").tap()
  await page.waitForURL(/\/local\/.+/)
  await page.getByRole("button", { name: "Add shape", exact: true }).tap()
  await page.getByRole("menuitem", { name: /Rectangle/ }).tap()
  await expect(page.getByRole("menuitem", { name: /Rectangle/ })).toHaveCount(0)

  const host = await page.locator("[data-canvas-host]").boundingBox()
  expect(host).not.toBeNull()
  if (!host) return
  const x = host.x + host.width * 0.55
  const y = host.y + host.height * 0.45
  const touch = await page.context().newCDPSession(page)
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] })
  for (let step = 1; step <= 10; step++) {
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchMove", touchPoints: [{ x: x + step * 20, y: y + step * 12 }],
    })
  }
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  await expect(page.getByRole("button", { name: "Select", exact: true })).toHaveAttribute("aria-pressed", "true")
  await expect(page.getByRole("button", { name: "Delete selection", exact: true })).toBeVisible()

  await page.touchscreen.tap(x + 100, y + 60)
  await page.touchscreen.tap(x + 100, y + 60)
  const editor = page.locator("[data-canvas-host] textarea")
  await expect(editor).toBeFocused()
  await editor.fill("Touch shape regression")
  await page.touchscreen.tap(x - 80, y + 220)
  await expect(editor).toHaveCount(0)
  await page.touchscreen.tap(x + 100, y + 60)
  await page.touchscreen.tap(x + 100, y + 60)
  await expect(editor).toHaveValue("Touch shape regression")
  await page.touchscreen.tap(x - 80, y + 220)
  await page.reload()
  await page.locator("[data-canvas-host]").waitFor()
  await page.touchscreen.tap(x + 100, y + 60)
  await page.touchscreen.tap(x + 100, y + 60)
  await expect(editor).toHaveValue("Touch shape regression")
  await page.touchscreen.tap(x - 80, y + 220)
  await page.touchscreen.tap(x + 100, y + 60)
  await page.getByRole("button", { name: "Delete selection", exact: true }).tap()
  await expect(page.getByRole("button", { name: "Delete selection", exact: true })).toHaveCount(0)
  await page.keyboard.press("Control+z")
  await page.touchscreen.tap(x + 100, y + 60)
  await page.touchscreen.tap(x + 100, y + 60)
  await expect(editor).toHaveValue("Touch shape regression")
})
