import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"
import { LanguageSetting } from "./language-setting"
import { ByokKeyForm } from "@/features/agent/byok/byok-key-form"
import { initLanguage, resolveLocale, t, useLocaleStore } from "@/lib/i18n"


afterEach(() => {
  useLocaleStore.getState().setLanguage("system")
  vi.restoreAllMocks()
})


it("switches immediately without discarding a key draft and restores the preference across reloads", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previous = globals.IS_REACT_ACT_ENVIRONMENT
  globals.IS_REACT_ACT_ENVIRONMENT = true
  useLocaleStore.getState().setLanguage("en")
  initLanguage()
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  try {
    act(() => root.render(<><LanguageSetting /><ByokKeyForm /></>))
    const keyInput = container.querySelector<HTMLInputElement>('input[type="password"]')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(keyInput, "draft-not-a-real-key")
      keyInput.dispatchEvent(new Event("input", { bubbles: true }))
    })
    const select = container.querySelector("select")!
    act(() => { select.value = "zh-CN"; select.dispatchEvent(new Event("change", { bubbles: true })) })
    expect(container.textContent).toContain("保存")
    expect(container.textContent).toContain("模型")
    expect(container.querySelector('input[type="password"]')).toBe(keyInput)
    expect(keyInput.value).toBe("draft-not-a-real-key")
    expect(document.documentElement.lang).toBe("zh-CN")
    expect(localStorage.getItem("dim0-language")).toBe("zh-CN")
    vi.resetModules()
    const reloaded = await import("@/lib/i18n")
    expect(reloaded.useLocaleStore.getState().locale).toBe("zh-CN")
    act(() => { select.value = "en"; select.dispatchEvent(new Event("change", { bubbles: true })) })
    expect(container.textContent).toContain("Save")
    expect(keyInput.value).toBe("draft-not-a-real-key")
  } finally {
    act(() => root.unmount())
    container.remove()
    globals.IS_REACT_ACT_ENVIRONMENT = previous
  }
})


it("resolves device language, falls back safely and interpolates translated messages", () => {
  expect(resolveLocale("system", "zh-TW")).toBe("zh-CN")
  expect(resolveLocale("system", "fr-FR")).toBe("en")
  expect(resolveLocale("en", "zh-CN")).toBe("en")
  useLocaleStore.getState().setLanguage("zh-CN")
  expect(t("Your {provider} key", { provider: "OpenAI" })).toBe("你的 OpenAI 密钥")
  expect(t("gpt-5.4")).toBe("gpt-5.4")
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage denied") })
  expect(() => useLocaleStore.getState().setLanguage("en")).not.toThrow()
  expect(t("Save")).toBe("Save")
})
