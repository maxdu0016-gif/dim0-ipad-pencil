import { describe, expect, it, vi } from "vitest"
import { addNode, freshStore } from "@/test/canvas"
import { asNodeId } from "@canvas-harness/core"
import { liveBoardText, supportsBoardVision, prepareNativeBoardContext } from "./live-board-context"
import { requestNativePencilSync } from "@/features/ios/native-pencil-bridge"
import { useBoardAppStore } from "@/features/board/harness/store/board-app-store"
import { toOpenAiMessages } from "../engine/byok-client"


vi.mock("@/features/ios/native-pencil-bridge", () => ({ requestNativePencilSync: vi.fn() }))


describe("live board grounding", () => {
  it("waits for native ink synchronization before capturing the current board", async () => {
    const previous = window.webkit
    window.webkit = { messageHandlers: { dim0NativePencil: { postMessage: vi.fn() } } }
    useBoardAppStore.setState({ canEdit: true, viewMode: "board" })
    vi.useFakeTimers()
    try {
      let accept!: (value: { total: number }) => void
      vi.mocked(requestNativePencilSync).mockReturnValue(new Promise((resolve) => { accept = resolve }))
      const finished = vi.fn()
      const ready = prepareNativeBoardContext().then(finished)
      await vi.runAllTimersAsync()
      expect(finished).not.toHaveBeenCalled()
      accept({ total: 1 })
      await vi.runAllTimersAsync()
      await ready
      expect(finished).toHaveBeenCalledOnce()
    } finally {
      window.webkit = previous
      vi.useRealTimers()
    }
  })

  it("sends the body of an unselected shape, including edits not yet persisted", () => {
    const store = freshStore()
    addNode(store, "shape", "Course")
    store.updateNode(asNodeId("shape"), { content: "Derivative of x squared is 2x" })
    const context = liveBoardText(store)
    expect(context).toContain("Derivative of x squared is 2x")
    expect(context).toContain("Course")
    expect(store.getSelection()).toHaveLength(0)
  })

  it("keeps text-only models text-only and recognizes the user's GPT-5.4", () => {
    expect(supportsBoardVision("gpt-4")).toBe(false)
    expect(supportsBoardVision("gpt-5.4")).toBe(true)
    expect(supportsBoardVision("openai/gpt-5.4")).toBe(true)
    expect(supportsBoardVision("gpt-4o")).toBe(true)
  })

  it("encodes a board image as actual multimodal content, preserving text-only requests", () => {
    const image = "data:image/jpeg;base64,example"
    const messages = toOpenAiMessages([{ role: "user", content: "Read my board", images: [image] }, { role: "user", content: "Hello" }])
    expect(messages[0].content).toEqual([{ type: "text", text: "Read my board" }, { type: "image_url", image_url: { url: image, detail: "high" } }])
    expect(messages[1].content).toBe("Hello")
  })
})
