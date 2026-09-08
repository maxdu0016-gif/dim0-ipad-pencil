import { useEffect, useRef, useState } from "react"
import { MicrophoneIcon } from "@phosphor-icons/react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { useT, useLocaleStore } from "@/lib/i18n"


/** Capture native dictation into an editable draft; only explicit confirmation inserts text. */
export function SpeechInput({ disabled, onConfirm }: { disabled?: boolean; onConfirm: (text: string) => void }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [recording, setRecording] = useState(false)
  const [text, setText] = useState("")
  const [error, setError] = useState("")
  const requestId = useRef<string | null>(null)
  const send = (kind: string, id = requestId.current): void => {
    if (id) window.webkit?.messageHandlers?.dim0Speech?.postMessage({ version: 1, kind, requestId: id, locale: useLocaleStore.getState().locale === "zh-CN" ? "zh-CN" : "en-US" })
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
      toast.info(t("In-app dictation is unavailable in this version. Use the iPad keyboard microphone, then review the text before sending."))
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
    <button type="button" aria-label={t("Speech to text")} title={t("Dictate, then review before sending")} disabled={disabled}
      onPointerDown={(event) => event.preventDefault()} onClick={start}
      className="inline-flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-accent disabled:opacity-40">
      <MicrophoneIcon className="size-5" />
    </button>
    <Dialog open={open} onOpenChange={(next) => { if (!next) close() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Speech to text")}</DialogTitle>
          <DialogDescription>{t("Apple transcribes your speech. Review the draft, insert it, then send it to AI manually.")}</DialogDescription>
        </DialogHeader>
        <textarea aria-label={t("Speech draft")} value={text} onChange={(event) => setText(event.target.value)}
          readOnly={recording} rows={6} className="w-full rounded-md border p-3 text-base" />
        <p role="status" className="text-sm">{error || t(recording ? "Listening…" : "Review and edit the text")}</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>{t("Cancel")}</Button>
          {recording ? <Button onClick={() => send("stop")}>{t("Stop dictation")}</Button>
            : <Button disabled={!text.trim() || disabled} onClick={() => { onConfirm(text.trim()); close() }}>{t("Insert into message")}</Button>}
        </div>
      </DialogContent>
    </Dialog>
  </>
}
