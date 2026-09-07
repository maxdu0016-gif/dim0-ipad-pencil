import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"
import { FloatingIsland } from "./floating-island"


const { submit, showError } = vi.hoisted(() => ({ submit: vi.fn(), showError: vi.fn() }))
vi.mock("sonner", () => ({ toast: { error: showError } }))
vi.mock("@/features/agent/hooks/use-chat-submit", () => ({ useChatSubmit: () => submit }))
vi.mock("@/features/agent/api/send-message", () => ({ SendMessageError: class extends Error {} }))
vi.mock("@/features/agent/hooks/chat-context", () => ({ useChat: () => ({ local: false }) }))
vi.mock("@/features/agent/hooks/use-message-context", () => ({ buildMessageContext: () => "", useHasMessageContext: () => false }))
vi.mock("@/features/agent/services/use-agent-availability", () => ({ useHasUsableModel: () => true }))
vi.mock("./use-current-assistant-message", () => ({ useCurrentAssistantMessage: () => undefined }))
vi.mock("../../../harness/store/board-app-store", () => ({ useBoardAppStore: () => false }))
vi.mock("./progress-line", () => ({ ProgressLine: () => null }))
vi.mock("@/components/icons", () => ({ SparklesIcon: () => null, SendIcon: () => null, LoaderIcon: () => null, CloseIcon: () => null }))
vi.mock("@phosphor-icons/react", () => ({ MicrophoneIcon: () => null }))
vi.mock("@/components/animations/thinking-indicator", () => ({ ThinkingIndicator: () => null }))
vi.mock("@/features/agent/components/chat/doc-attach", () => ({ DocAttachButton: () => null }))
vi.mock("@/features/agent/settings/settings-button", () => ({ SettingsButton: () => null }))


afterEach(() => vi.clearAllMocks())


it("lets touch users send, ignores IME confirmation, prevents duplicate sends and restores failed drafts", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previous = globals.IS_REACT_ACT_ENVIRONMENT
  globals.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  let rejectSend!: (reason: Error) => void
  submit.mockImplementation(() => new Promise((_resolve, reject) => { rejectSend = reject }))
  try {
    act(() => root.render(<FloatingIsland boardId="board" onOpenFullSheet={() => {}} />))
    const textarea = container.querySelector("textarea")!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "继续解释")
      textarea.dispatchEvent(new Event("input", { bubbles: true }))
    })
    act(() => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })))
    expect(submit).not.toHaveBeenCalled()
    const send = container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!
    expect(send.disabled).toBe(false)
    act(() => { send.click(); send.click() })
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledWith("继续解释", { attachedBoardId: "board", messageContext: "" })
    await act(async () => rejectSend(new Error("Offline")))
    expect(textarea.value).toBe("继续解释")
    expect(textarea.disabled).toBe(false)
    expect(showError).toHaveBeenCalledWith("Offline")
  } finally {
    act(() => root.unmount())
    container.remove()
    globals.IS_REACT_ACT_ENVIRONMENT = previous
  }
})
