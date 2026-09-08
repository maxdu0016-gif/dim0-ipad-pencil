/* eslint-disable react-refresh/only-export-components -- this is a hook module (it returns a dialog element + drives toasts), not a component file. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { toast } from "sonner"
import { CircleNotchIcon } from "@/components/icons"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { generateUuid } from "@/lib/common"
import { useIsSignedIn } from "@/lib/auth"
import { useByokStore } from "@/features/agent/byok/byok-store"
import { getLocalStores } from "@/features/local-stores"
import { getCanvasStoreRef } from "@/features/board/harness/canvas-store-ref"
import { useBoardAppStore } from "@/features/board/harness/store/board-app-store"
import { addDocumentNode } from "@/features/board/harness/agent/doc-node"
import { resolveParseClient } from "@/features/agent/engine/doc-parse"
import { ingestDocument } from "@/features/agent/local/ingest-doc"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { DOCUMENT_ACCEPT, documentExtension, parseOfficeDocument } from "./office-document"
import { useT } from "@/lib/i18n"


// Instant client-side reject (saves the upload); the /ai/parse endpoint enforces
// the same limits authoritatively. Keep in sync with MAX_PDF_BYTES.
const MAX_FILE_BYTES = 5 * 1024 * 1024


export type LocalDocUpload = {
  /** Whether the chosen PDF can be parsed with the current service configuration. */
  canParse: boolean
  busy: boolean
  /** Open the import dialog with a directly tappable file input. */
  pick: () => void
  importFile: (file: File, position?: { x: number; y: number }) => Promise<void>
  /**
   * Mount once: the PDF import dialog and same-name replacement confirmation.
   */
  elements: ReactNode
}


/**
 * Shared document upload flow: Office text locally or PDF OCR, chunk + persist,
 * reindex, and drop a `document` node on the canvas. Backs BOTH the chat attach
 * button and the toolbar "Document" item so they behave identically.
 *
 * Titles are unique per board (the offline-first analog of a filename in a
 * folder): a same-name upload prompts to override in place. `canParse` reports
 * PDF service availability; Office text extraction needs no parsing key.
 */
export const useLocalDocUpload = (boardId: string): LocalDocUpload => {
  const t = useT()
  const signedIn = useIsSignedIn()
  // Raw so the button re-enables the moment a signed-out user saves a key.
  const byokKey = useByokStore((s) => s.parseKey).trim() || null
  const [pickerOpen, setPickerOpen] = useState(false)
  // Synchronous re-entrancy guard: `busy` state lags a render, so a rapid second
  // pick could slip through before it flips. A ref closes that window.
  const inFlight = useRef(false)
  const [busy, setBusy] = useState(false)
  const [override, setOverride] = useState<File | null>(null)
  const confirmRef = useRef<((replace: boolean) => void) | null>(null)
  const positionRef = useRef<{ x: number; y: number } | undefined>(undefined)
  useEffect(() => () => { confirmRef.current?.(false) }, [])
  const confirmOverride = (replace: boolean): void => {
    confirmRef.current?.(replace)
    confirmRef.current = null
    setOverride(null)
  }
  const canParse = resolveParseClient({ signedIn, byokKey }) !== null

  const ingest = useCallback(
    async (file: File): Promise<void> => {
      const client = resolveParseClient({ signedIn, runId: generateUuid(), byokKey })
      const office = ["docx", "pptx"].includes(documentExtension(file))
      if (!office && !client) {
        toast.error("Sign in or add a Mistral key to upload documents.")
        return
      }
      setBusy(true)
      const id = toast(`Reading ${file.name}…`, { icon: <Spinner />, duration: Infinity })
      try {
        const { markdown, pages } = office ? await parseOfficeDocument(file) : await client!.parse(file)
        const { docId, chunks, replaced } = await ingestDocument({ boardId, title: file.name, markdown, pages })
        toast.dismiss(id)
        if (chunks === 0 || !docId) {
          toast.error(t("No readable text found in this document. For image-only Office files, export to PDF and use OCR."))
          return
        }
        // Surface the document as a node on the canvas (id = docId). No-op on a
        // same-name override (the node already exists).
        const store = getCanvasStoreRef()
        if (store) addDocumentNode(store, { docId, title: file.name, boardId, rootId: useBoardAppStore.getState().rootId, position: positionRef.current })
        toast.success(`${replaced ? "Replaced" : "Added"} ${file.name} — ${chunks} passages ready to ask about.`)
      } catch (err) {
        toast.dismiss(id)
        toast.error(err instanceof Error ? err.message : t("Couldn't read the document."))
      } finally {
        setBusy(false)
      }
    },
    [boardId, signedIn, byokKey, t],
  )

  const onPickFile = useCallback(
    async (file: File, position?: { x: number; y: number }): Promise<void> => {
      if (busy || inFlight.current || override) {
        toast.info(t("Finish the current document import first."))
        return
      }
      if (!["pdf", "docx", "pptx"].includes(documentExtension(file))) {
        toast.error(t("Choose PDF, DOCX or PPTX. Save older DOC/PPT files as DOCX/PPTX or PDF first."))
        return
      }
      if (file.size > MAX_FILE_BYTES) {
        toast.error(t("Document must be under 5 MB."))
        return
      }
      positionRef.current = position
      inFlight.current = true
      try {
        // Same-name on this board → confirm override (parse only AFTER the user
        // decides, so a cancelled override never spends an OCR call).
        const { docs } = await getLocalStores()
        const existing = await docs.findByTitle(boardId, file.name)
        if (existing) {
          setOverride(file)
          const replace = await new Promise<boolean>((resolve) => { confirmRef.current = resolve })
          if (!replace) return
        }
        await ingest(file)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Couldn't open the document store.")
      } finally {
        inFlight.current = false
      }
    },
    [boardId, busy, ingest, override, t],
  )

  const pick = useCallback((): void => {
    if (busy || inFlight.current) return
    setPickerOpen(true)
  }, [busy])

  const elements = (
    <>
      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Import document")}</DialogTitle>
            <DialogDescription>
              {t("PDF, Word (.docx), PowerPoint (.pptx), up to 5 MB. Office text is read on this device; images and charts are not extracted. PDF requires a Mistral key or managed access.")}
            </DialogDescription>
          </DialogHeader>
          <input
            type="file"
            aria-label={t("Choose document")}
            accept={DOCUMENT_ACCEPT}
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ""
              if (file) {
                setPickerOpen(false)
                void onPickFile(file)
              }
            }}
          />
        </DialogContent>
      </Dialog>
      <AlertDialog open={override !== null} onOpenChange={(o) => !o && confirmOverride(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace “{override?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              A document with this name is already on this board. Uploading will replace its contents.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => confirmOverride(false)}>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                confirmOverride(true)
              }}
            >
              Replace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )

  return { canParse, busy, pick, importFile: onPickFile, elements }
}


/** Shared 16px spinning loader (composer button busy-state + upload toast). */
export const Spinner = () => (
  <CircleNotchIcon className="size-4 animate-spin [animation-duration:750ms]" strokeWidth={2} />
)
