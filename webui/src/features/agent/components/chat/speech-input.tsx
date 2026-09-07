import { useEffect, useRef, useState } from "react"
import { MicrophoneIcon } from "@phosphor-icons/react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"


/** Capture native dictation into an editable draft; only explicit confirmation inserts text. */
export function SpeechInput({ disabled, onConfirm }: { disabled?: boolean; onConfirm: (text: string) => void }) {
  const [open, setOpen] = useState(false)
  const [recording, setRecording] = useState(false)
  const [text, setText] = useState("")
  const [error, setError] = useState("")
  const requestId = useRef<string | null>(null)
  const send = (kind: string, id = requestId.current): void => {
    if (id) window.webkit?.messageHandlers?.dim0Speech?.postMessage({ version: 1, kind, requestId: id, locale: navigator.language })
  }

  useEffect(() => {
    const listener = (event: Event): void => {
      const detail: unknown = (event as CustomEvent<unknown>).detail
      if (!detail || typeof detail !== "object" || !("requestId" in detail) || detail.requestId !== requestId.current) return
      if ("text" in detail && typeof detail.text === "string") setText(detail.text)
      if ("error" in detail && typeof detail.error === "string") setError(detail.error)
      if ("done" in detail && detail.done === true) setRecording(false)
    }
    window.addEventListener("dim0:speech", listener)
    return () => {
      window.removeEventListener("dim0:speech", listener)
      if (requestId.current) window.webkit?.messageHandlers?.dim0Speech?.postMessage({ version: 1, kind: "cancel", requestId: requestId.current })
    }
  }, [])

  const close = (): void => {
    send("cancel")
    requestId.current = null
    setRecording(false)
    setOpen(false)
  }
  const start = (): void => {
    if (!window.webkit?.messageHandlers?.dim0Speech) {
      toast.info("此版本尚不支持应用内语音。可先点输入框，使用 iPad 键盘的麦克风听写；检查文字后再发送。")
      return
    }
    requestId.current = crypto.randomUUID()
    setText("")
    setError("")
    setRecording(true)
    setOpen(true)
    send("start")
  }

  return <>
    <button type="button" aria-label="语音转文字" title="语音转文字，检查后发送" disabled={disabled}
      onPointerDown={(event) => event.preventDefault()} onClick={start}
      className="inline-flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-accent disabled:opacity-40">
      <MicrophoneIcon className="size-5" />
    </button>
    <Dialog open={open} onOpenChange={(next) => { if (!next) close() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>语音转文字</DialogTitle>
          <DialogDescription>由 Apple 语音识别转写。结束后可修改文字，放入输入框后再手动发送给 AI。</DialogDescription>
        </DialogHeader>
        <textarea aria-label="语音文字草稿" value={text} onChange={(event) => setText(event.target.value)}
          readOnly={recording} rows={6} className="w-full rounded-md border p-3 text-base" />
        <p role="status" className="text-sm">{error || (recording ? "正在听写…" : "请检查和修改文字")}</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>取消</Button>
          {recording ? <Button onClick={() => send("stop")}>结束听写</Button>
            : <Button disabled={!text.trim() || disabled} onClick={() => { onConfirm(text.trim()); close() }}>放入输入框</Button>}
        </div>
      </DialogContent>
    </Dialog>
  </>
}
