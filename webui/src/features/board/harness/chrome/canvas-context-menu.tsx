import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type RefObject,
} from "react"
import { toast } from "sonner"
import type { CanvasStore, NodeId, EdgeId, Renderer } from "@canvas-harness/core"
import { exportSelection, exportSelectionSvg, hitTestAny, screenToWorld, serializeSelection } from "@canvas-harness/core"
import { useSelection } from "@canvas-harness/react"
import { useT } from "@/lib/i18n"
import { bindLongPress } from "./long-press"
import { pasteBoardText } from "./paste-board-text"
import { removeNodesSubtree, collectSubtreeIds } from "../graph/subtree"
import { isDurableDelete } from "../node-types/durable-delete"
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import {
  Clipboard as ClipboardIcon,
  StackMinus as StackMinusIcon,
  StackPlus as StackPlusIcon,
} from "@phosphor-icons/react"
import {
  ArticleSummaryIcon,
  ChatTranslateIcon,
  DrawIcon,
  ImagePlaceholderIcon,
  SchemaMapIcon,
  SparklesIcon,
  TreeMapIcon,
} from "@/components/icons"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { buildContextTextFromNodes } from "@/features/board/utils/context-text"
import { useAiSparkActions } from "@/features/board/hooks/use-ai-spark-actions"
import { useIsLocalBoard } from "@/features/board/lib/use-is-local-board"
import { useLocalTransform, type LocalTransformKind } from "@/features/agent/local/use-local-transform"
import { useHasUsableModel } from "@/features/agent/services/use-agent-availability"
import { useBoardAppStore } from "../store/board-app-store"
import { nodeToNote } from "../convert/node-to-note"
import type { NoteNode } from "@/features/board/types/flow"
import type { DimNode } from "@/features/board/model"


export type CanvasContextMenuProps = {
  /** Canvas wrap ref — the menu's contextmenu listener attaches here. */
  wrapRef: RefObject<HTMLElement | null>
  store: CanvasStore
  /**
   * Renderer ref — read at export time to pass the live asset cache
   * into `exportSelection`. Without the cache, image and icon nodes
   * are silently skipped in the PNG output (canvas-harness 0.1.15+).
   */
  rendererRef: RefObject<Renderer | null>
  onImport?: (position: { x: number; y: number }) => void
}


/** Common languages shown as one-click items in the Translate submenu. */
const COMMON_LANGUAGES: ReadonlyArray<string> = [
  "English",
  "French",
  "Spanish",
  "Chinese",
  "Japanese",
  "Korean",
  "German",
  "Portuguese",
]


type AiSparkVisual = {
  key: string
  Icon: typeof ArticleSummaryIcon
}


/** Icon per AI Spark action — keeps the menu visually scannable. */
const AI_SPARK_VISUALS: ReadonlyArray<AiSparkVisual> = [
  { key: "summarize", Icon: ArticleSummaryIcon },
  { key: "mapify", Icon: TreeMapIcon },
  { key: "schemify", Icon: SchemaMapIcon },
  { key: "quizify", Icon: ClipboardIcon },
  { key: "drawify", Icon: DrawIcon },
  { key: "explain", Icon: SparklesIcon },
]


// Canvas AI-action key → the local (in-browser) transform kind. Actions with no
// local equivalent (drawify, translate) are omitted and stay backend-only.
const LOCAL_TRANSFORM_BY_ACTION: Record<string, LocalTransformKind> = {
  summarize: "summify",
  mapify: "mapify",
  schemify: "schemify",
  quizify: "quizify",
  explain: "mapify",
}


/**
 * Build the structured context text for the agent from the current
 * canvas selection. Skips edges (the agent only consumes nodes).
 */
const buildSelectedContextText = (
  store: CanvasStore,
  opts: { skipPrefix?: boolean } = {},
): string => {
  const ids = store.getSelection()
  const synthetic: NoteNode[] = []
  for (const id of ids) {
    const node = store.getNode(id as NodeId)
    if (!node) continue
    const note = nodeToNote(node)
    synthetic.push({ id: note.id, data: note } as unknown as NoteNode)
  }
  if (synthetic.length === 0) return ""
  return buildContextTextFromNodes(synthetic, opts).trim()
}


/**
 * Right-click context menu for the canvas-harness board — Position / Export /
 * AI / Translate. Built on the real Radix menu (via `ui/dropdown-menu`), so
 * positioning collides-and-flips against the viewport (no more part-hidden
 * menus) and AI/Translate are proper hover submenus.
 *
 * The canvas owns pointer events, so a Radix ContextMenuTrigger can't overlay
 * it; instead the canvas-aware right-click detection (selection-gated, skips
 * editor inputs) sets the anchor point, and the menu opens (controlled) against
 * a zero-size trigger placed there.
 */
export function CanvasContextMenu({ wrapRef, store, rendererRef, onImport }: CanvasContextMenuProps) {
  const t = useT()
  const canEdit = useBoardAppStore((s) => s.canEdit)
  const selected = useSelection()
  const hasSelection = selected.length > 0
  const [pasteFallback, setPasteFallback] = useState<{ x: number; y: number } | null>(null)
  const [pasteText, setPasteText] = useState("")
  const [deletePending, setDeletePending] = useState(false)
  const boardId = useBoardAppStore((s) => s.boardId)
  // AI actions need an in-browser LLM on local boards; hide the section when no
  // model key is usable (parity with the floating island) instead of offering
  // actions that can only fail. Online boards use the backend, so unaffected.
  const isLocal = useIsLocalBoard()
  const hasUsableModel = useHasUsableModel()
  const showAiSection = !isLocal || hasUsableModel
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null)
  const [exportTransparent, setExportTransparent] = useState(false)
  const [customLanguage, setCustomLanguage] = useState("")

  const { actions: aiActions, processingKey, runAction } = useAiSparkActions()
  const runLocalTransform = useLocalTransform()

  const aiMenuActions = useMemo(
    // On local boards, drop actions with no in-browser transform yet (drawify).
    () => aiActions.filter((a) => a.key !== "translate" && !(isLocal && a.key === "drawify")),
    [aiActions, isLocal],
  )

  const closeMenu = useCallback(() => setMenuPos(null), [])

  // Shared right-click/long-press trigger; editing text keeps the system menu.
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const allowed = (target: EventTarget | null): boolean => {
      const app = useBoardAppStore.getState()
      return app.viewMode === "board" && app.tool !== "ink" && app.tool !== "eraser" &&
        !(target instanceof Element && target.closest("input,textarea,[contenteditable=true],button,[role=menu],[role=dialog],iframe"))
    }
    const openAt = (x: number, y: number): void => {
      const rect = wrap.getBoundingClientRect()
      const world = screenToWorld({ x: x - rect.left, y: y - rect.top }, store.getCamera())
      const hit = hitTestAny(store, world, store.getCamera().z)
      const id = hit ? ("nodeId" in hit ? hit.nodeId : hit.edgeId) : null
      store.resetInteractionState()
      if (!id) store.setSelection([])
      else if (!store.getSelection().includes(id)) store.setSelection([id])
      setMenuPos({ x, y })
    }
    const onContext = (e: MouseEvent): void => {
      if (!allowed(e.target)) return
      e.preventDefault()
      openAt(e.clientX, e.clientY)
    }
    const unbind = bindLongPress(wrap, openAt, allowed)
    wrap.addEventListener("contextmenu", onContext)
    return () => { unbind(); wrap.removeEventListener("contextmenu", onContext) }
  }, [wrapRef, store])

  const worldPosition = (): { x: number; y: number } => {
    const rect = wrapRef.current?.getBoundingClientRect()
    return screenToWorld({ x: (menuPos?.x ?? 0) - (rect?.left ?? 0), y: (menuPos?.y ?? 0) - (rect?.top ?? 0) }, store.getCamera())
  }
  const handleCopy = async (): Promise<void> => {
    if (selected.some((id) => ["folder", "document"].includes(store.getNode(id as NodeId)?.type ?? ""))) {
      toast.info(t("Import documents separately; copy a folder's contents instead."))
      return
    }
    try {
      const clip = serializeSelection(store)
      if (!clip.nodes.length && !clip.edges.length) {
        toast.info(t("Select the connected notes to copy this arrow."))
        return
      }
      await navigator.clipboard.writeText(JSON.stringify(clip))
      toast.success(t("Copied to clipboard"))
    } catch { toast.error(t("Could not access the clipboard. Try the system Copy menu.")) }
  }
  const handlePaste = async (): Promise<void> => {
    if (!canEdit || !boardId) return
    const at = worldPosition()
    let text: string
    try { text = await navigator.clipboard.readText() }
    catch { setPasteText(""); setPasteFallback(at); return }
    try { await pasteBoardText(store, text, at, boardId, useBoardAppStore.getState().rootId) }
    catch (error) { toast.error(t(error instanceof Error ? error.message : "Could not paste.")) }
  }
  const removeSelected = (): void => {
    if (!canEdit) return
    const ids = store.getSelection()
    removeNodesSubtree(store, ids.filter((id) => store.getNode(id as NodeId)) as NodeId[])
    store.batch(() => ids.forEach((id) => { if (store.getEdge(id as EdgeId)) store.removeEdge(id as EdgeId) }))
    setDeletePending(false)
  }
  const handleDelete = (): void => {
    const roots = selected.filter((id) => store.getNode(id as NodeId)) as NodeId[]
    const subtree = collectSubtreeIds(store.getAllNodes() as DimNode[], roots)
    if ([...subtree].some((id) => isDurableDelete(store.getNode(id)?.type))) setDeletePending(true)
    else removeSelected()
  }

  const selection = useCallback(() => store.getSelection(), [store])

  // ---- Position ---------------------------------------------------------
  const handleSendBackward = useCallback(() => store.sendBackward(selection()), [store, selection])
  const handleSendForward = useCallback(() => store.bringForward(selection()), [store, selection])
  const handleSendToBack = useCallback(() => store.sendToBack(selection()), [store, selection])
  const handleSendToFront = useCallback(() => store.bringToFront(selection()), [store, selection])

  // ---- Export -----------------------------------------------------------
  const handleExportPng = useCallback(async () => {
    try {
      const blob = await exportSelection(store, {
        transparentBackground: exportTransparent,
        // Pass the live renderer's asset cache so image + icon nodes
        // paint from already-decoded bitmaps. Without this, the lib
        // silently skips those node types in the output (back-compat
        // shape from canvas-harness 0.1.15).
        assetCache: rendererRef.current?.getAssetCache(),
      })
      try {
        // Try clipboard first (Notion / Figma-style behavior).
        await navigator.clipboard.write([
          new ClipboardItem({ "image/png": blob }),
        ])
        toast.success("Copied to clipboard")
      } catch {
        // Fall back to file download.
        const url = URL.createObjectURL(blob)
        Object.assign(document.createElement("a"), {
          href: url,
          download: "selection.png",
        }).click()
        URL.revokeObjectURL(url)
      }
    } catch (err) {
      console.error("[context-menu] PNG export failed", err)
      toast.error("Couldn't export selection")
    }
  }, [store, exportTransparent, rendererRef])

  const handleExportSvg = useCallback(() => {
    try {
      const svg = exportSelectionSvg(store)
      const blob = new Blob([svg], { type: "image/svg+xml" })
      const url = URL.createObjectURL(blob)
      Object.assign(document.createElement("a"), {
        href: url,
        download: "selection.svg",
      }).click()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error("[context-menu] SVG export failed", err)
      toast.error("Couldn't export selection")
    }
  }, [store])

  // ---- AI / Translate ---------------------------------------------------
  const handleAiAction = useCallback(
    async (actionKey: string) => {
      if (!boardId) {
        toast.error("Select a board first.")
        return
      }
      const contextText = buildSelectedContextText(store)
      if (!contextText) {
        toast.error("Select at least one node with content.")
        return
      }
      // Local board: run the in-browser transform instead of the backend /tools.
      if (isLocal) {
        const kind = LOCAL_TRANSFORM_BY_ACTION[actionKey]
        if (!kind) {
          toast.error("Not available on local boards yet.")
          return
        }
        const id = toast(`${actionKey}…`, { duration: Infinity })
        try {
          const { ok } = await runLocalTransform(kind, contextText)
          toast.dismiss(id)
          if (ok) toast.success("Added to the board.")
          else toast.error("Nothing was created.")
        } catch (error) {
          console.error("Local transform failed:", error)
          toast.dismiss(id)
          toast.error("Failed — check your model key in settings.")
        }
        return
      }
      await runAction({ boardId, contextText, actionKey })
    },
    [boardId, store, runAction, isLocal, runLocalTransform],
  )

  const handleTranslate = useCallback(
    async (language: string) => {
      if (!boardId) {
        toast.error("Select a board first.")
        return
      }
      const contextText = buildSelectedContextText(store, { skipPrefix: true })
      if (!contextText) {
        toast.error("Select at least one node with content.")
        return
      }
      await runAction({
        boardId,
        contextText,
        actionKey: "translate",
        targetLanguage: language,
      })
    },
    [boardId, store, runAction],
  )

  return (
    <>
    <DropdownMenu open={!!menuPos} onOpenChange={(open) => { if (!open) closeMenu() }} modal={false}>
      {/* Zero-size anchor placed at the click point; Radix positions the menu
          against it (with viewport collision) while the canvas keeps its own
          pointer events. Not aria-hidden: Radix makes it the menu trigger (it
          projects focusable button semantics on), and a focusable aria-hidden
          node is an a11y violation. */}
      <DropdownMenuTrigger asChild>
        <span
          style={{ position: "fixed", left: menuPos?.x ?? 0, top: menuPos?.y ?? 0, width: 0, height: 0 }}
        />
      </DropdownMenuTrigger>

      <DropdownMenuContent
        // Re-key on the anchor point so a right-click elsewhere while the menu
        // is already open remounts the content and re-anchors at the new point
        // (moving the zero-size anchor's CSS position alone won't re-measure).
        key={menuPos ? `${menuPos.x},${menuPos.y}` : undefined}
        align="start"
        side="bottom"
        sideOffset={2}
        collisionPadding={8}
        className="min-w-[220px] max-h-[70dvh] overflow-y-auto [&_[role=menuitem]]:min-h-11"
        // Don't yank focus to the invisible anchor when closing.
        onCloseAutoFocus={(e) => e.preventDefault()}
        // The content is portaled to <body>, outside the canvas wrap whose
        // listener suppresses the native menu — so suppress it here too.
        onContextMenu={(e) => e.preventDefault()}
      >
        <DropdownMenuItem disabled={!canEdit} onSelect={() => onImport ? onImport(worldPosition()) : useBoardAppStore.getState().setChromeDialog("document-upload")}>
          {t("Import document")}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!hasSelection} onSelect={() => void handleCopy()}>{t("Copy")}</DropdownMenuItem>
        <DropdownMenuItem disabled={!canEdit} onSelect={() => void handlePaste()}>{t("Paste")}</DropdownMenuItem>
        <DropdownMenuItem disabled={!canEdit || !hasSelection} onSelect={handleDelete}>{t("Delete")}</DropdownMenuItem>
        {hasSelection && <>
        <DropdownMenuLabel className="text-muted-foreground">{t("Position")}</DropdownMenuLabel>
        <DropdownMenuItem disabled={!canEdit} onSelect={() => handleSendBackward()}>
          <StackMinusIcon className="size-4" />
          {t("Send backward")}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canEdit} onSelect={() => handleSendForward()}>
          <StackPlusIcon className="size-4" />
          {t("Send forward")}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canEdit} onSelect={() => handleSendToBack()}>
          <StackMinusIcon className="size-4" />
          {t("Send to back")}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canEdit} onSelect={() => handleSendToFront()}>
          <StackPlusIcon className="size-4" />
          {t("Send to front")}
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-muted-foreground">{t("Export")}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => void handleExportPng()}>
          <ClipboardIcon className="size-4" />
          {t("Copy selected as PNG")}
        </DropdownMenuItem>
        <DropdownMenuCheckboxItem
          checked={exportTransparent}
          onCheckedChange={(v) => setExportTransparent(v === true)}
          // Toggling shouldn't dismiss the menu.
          onSelect={(e) => e.preventDefault()}
        >
          {t("Transparent background")}
        </DropdownMenuCheckboxItem>
        <DropdownMenuItem onSelect={() => handleExportSvg()}>
          <ImagePlaceholderIcon className="size-4" />
          {t("Download as SVG")}
        </DropdownMenuItem>

        {showAiSection && canEdit && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <SparklesIcon className="size-4 text-secondary-foreground" weight="fill" />
                AI
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-[190px]" onContextMenu={(e) => e.preventDefault()}>
                {aiMenuActions.map((action) => {
                  const Icon = AI_SPARK_VISUALS.find((v) => v.key === action.key)?.Icon ?? SparklesIcon
                  return (
                    <DropdownMenuItem
                      key={action.key}
                      disabled={!!processingKey}
                      onSelect={() => void handleAiAction(action.key)}
                    >
                      <Icon className="size-4 text-secondary-foreground" />
                      <span>{action.label}</span>
                      {action.key === "drawify" && (
                        <span className="ml-auto rounded-sm border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                          Beta
                        </span>
                      )}
                    </DropdownMenuItem>
                  )
                })}
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            {!isLocal && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <ChatTranslateIcon className="size-4 text-secondary-foreground" />
                  Translate
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-[190px]" onContextMenu={(e) => e.preventDefault()}>
                  {COMMON_LANGUAGES.map((language) => (
                    <DropdownMenuItem key={language} onSelect={() => void handleTranslate(language)}>
                      {language}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  {/* Plain row (not a menu item) so it doesn't close on click;
                      stop keydown so Radix's menu typeahead doesn't eat typing. */}
                  <div
                    className="flex items-center gap-1 px-1 py-1"
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <input
                      className="h-7 min-w-0 flex-1 rounded-sm border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                      placeholder="Custom language…"
                      value={customLanguage}
                      onChange={(e) => setCustomLanguage(e.target.value)}
                      onPointerDown={(e) => e.stopPropagation()}
                    />
                    <button
                      type="button"
                      className="h-7 shrink-0 rounded-sm border border-border bg-muted/70 px-2 text-xs font-medium hover:text-secondary-foreground"
                      onClick={() => {
                        void handleTranslate(customLanguage.trim() || "English")
                        closeMenu()
                      }}
                    >
                      Go
                    </button>
                  </div>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
          </>
        )}
        </>}
      </DropdownMenuContent>
    </DropdownMenu>
    <Dialog open={!!pasteFallback} onOpenChange={(open) => { if (!open) setPasteFallback(null) }}>
      <DialogContent>
        <DialogTitle>{t("Paste")}</DialogTitle>
        <DialogDescription>{t("Touch and hold the field below, choose Paste, then add it to the board.")}</DialogDescription>
        <textarea aria-label={t("Clipboard content")} rows={5} className="w-full border rounded-md p-3 text-base" value={pasteText} onChange={(event) => setPasteText(event.target.value)} />
        <Button disabled={!pasteText.trim()} onClick={() => {
          if (!pasteFallback || !boardId || !canEdit) return
          void pasteBoardText(store, pasteText, pasteFallback, boardId, useBoardAppStore.getState().rootId)
            .then(() => setPasteFallback(null)).catch((error: unknown) => toast.error(t(error instanceof Error ? error.message : "Could not paste.")))
        }}>{t("Add to board")}</Button>
      </DialogContent>
    </Dialog>
    <Dialog open={deletePending} onOpenChange={setDeletePending}>
      <DialogContent>
        <DialogTitle>{t("Delete selected items?")}</DialogTitle>
        <DialogDescription>{t("Documents and folders include stored content. Deleting them cannot be undone.")}</DialogDescription>
        <Button variant="ghost" onClick={() => setDeletePending(false)}>{t("Cancel")}</Button>
        <Button variant="destructive" onClick={removeSelected}>{t("Delete")}</Button>
      </DialogContent>
    </Dialog>
    </>
  )
}
