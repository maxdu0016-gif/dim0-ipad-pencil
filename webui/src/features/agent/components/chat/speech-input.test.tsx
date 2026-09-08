import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { SpeechInput } from "./speech-input"
import { useLocaleStore } from "@/lib/i18n"


vi.mock("@phosphor-icons/react", () => ({ MicrophoneIcon: () => null }))
vi.mock("@/components/icons", () => ({ CloseIcon: () => null }))


it("keeps speech as a draft until confirmation and ignores stale recognition events", () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previous = globals.IS_REACT_ACT_ENVIRONMENT
  globals.IS_REACT_ACT_ENVIRONMENT = true
  const oldWebkit = window.webkit
  const postMessage = vi.fn()
  window.webkit = { messageHandlers: { dim0Speech: { postMessage } } }
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  const onConfirm = vi.fn()
  const click = (label: string): void => {
    const button = [...document.querySelectorAll("button")].find((el) => el.textContent === label || el.getAttribute("aria-label") === label)!
    act(() => button.click())
  }
  try {
    useLocaleStore.getState().setLanguage("zh-CN")
    act(() => root.render(<SpeechInput onConfirm={onConfirm} />))
    click("语音转文字")
    const { requestId } = postMessage.mock.calls[0][0] as { requestId: string }
    act(() => { window.dispatchEvent(new CustomEvent("dim0:speech", { detail: { requestId, text: "请总结白板", done: false } })) })
    expect(onConfirm).not.toHaveBeenCalled()
    click("结束听写")
    expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "stop", requestId }))
    expect(postMessage.mock.calls[0][0]).toMatchObject({ locale: "zh-CN" })
    act(() => { window.dispatchEvent(new CustomEvent("dim0:speech", { detail: { requestId, text: "请总结白板上的笔记", done: true } })) })
    act(() => { window.dispatchEvent(new CustomEvent("dim0:speech", { detail: { requestId: "stale", text: "wrong", done: true } })) })
    expect(onConfirm).not.toHaveBeenCalled()
    click("放入输入框")
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith("请总结白板上的笔记")
    expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "cancel", requestId }))
  } finally {
    act(() => root.unmount())
    container.remove()
    window.webkit = oldWebkit
    globals.IS_REACT_ACT_ENVIRONMENT = previous
    useLocaleStore.getState().setLanguage("system")
  }
})
