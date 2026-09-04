import { useEffect, useState } from "react"
import { toast } from "sonner"
import {
  ChevronDownIcon,
  CircleClusterIcon,
  CircleShapeIcon,
  ConnectorPathIcon,
  CursorSelectIcon,
  DiamondShapeIcon,
  EraserIcon,
  GraphViewIcon,
  GridViewIcon,
  HandGrabIcon,
  HandPanIcon,
  LayerStackIcon,
  ListViewIcon,
  LoaderRefreshIcon,
  NotepadIcon,
  PencilEditIcon,
  PresentationIcon,
  ShapesMenuIcon,
  SquareShapeIcon,
  TagIcon,
  TextTIcon,
  WeatherCloudIcon,
} from "@/components/icons"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Separator } from "@/components/ui/separator"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Slider } from "@/components/ui/slider"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { isIOSNative } from "@/platform"
import { requestNativePencilSync } from "@/features/ios/native-pencil-bridge"
import { getBoardPersistenceRef } from "@/features/board/persist/local/board-persistence-ref"
import { getBoardSyncRef } from "@/features/board/harness/sync/board-sync-ref"
import { useBoardAppStore } from "../store/board-app-store"
import {
  readToolbarDock,
  TOOLBAR_DOCK_CHANGE_EVENT,
  writeToolbarDock,
  type ToolbarDock,
} from "./toolbar-dock"
import { HarnessToolbarMore } from "./toolbar-more"
import { DockableToolbarTray } from "./toolbar-shell"


type ShapeTool = {
  id: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  shortcut?: string
}


/**
 * All built-in canvas-harness shape tools the user can pick from the
 * Shapes dropdown. Order + icon choices mirror prod's `top-bar.tsx`
 * shapeOptions. Tool ids are canvas-harness names (see
 * `convert/node-type.ts` for the dim0↔canvas mapping).
 */
const SHAPE_TOOLS: ReadonlyArray<ShapeTool> = [
  { id: "rect", label: "Rectangle", icon: SquareShapeIcon, shortcut: "R" },
  { id: "layered-rect", label: "Layered card", icon: LayerStackIcon },
  { id: "ellipse", label: "Ellipse", icon: CircleShapeIcon, shortcut: "O" },
  { id: "diamond", label: "Diamond", icon: DiamondShapeIcon, shortcut: "D" },
  { id: "soft-diamond", label: "Double diamond", icon: DiamondShapeIcon },
  { id: "layered-diamond", label: "Layered diamond", icon: LayerStackIcon },
  { id: "layered-ellipse", label: "Layered circle", icon: CircleClusterIcon },
  { id: "tag", label: "Tag", icon: TagIcon },
  { id: "thought-cloud", label: "Cloud", icon: WeatherCloudIcon },
  { id: "capsule", label: "Capsule", icon: TagIcon },
]


const SHAPE_TOOL_IDS = new Set(SHAPE_TOOLS.map((t) => t.id))


// The `border` width sits on EVERY state so toggling a visible border on
// hover/active doesn't shift the icon — the border COLOR carries the
// affordance and is set per-state (not on the base): these strings are
// assigned straight to `className` and never pass through tailwind-merge, so a
// base `border-transparent` would collide with the active `border-…/30` and
// win by CSS source order — swallowing the active border entirely.
//
// Hover is a lighter preview (translucent fill + faint border); active is the
// full-strength fill + border, so the two states read distinctly.
const baseButtonClass =
  "transition-colors !p-2.5 rounded-lg flex items-center justify-center gap-2 border"
const inactiveClass = `${baseButtonClass} border-transparent text-card-foreground hover:bg-secondary/50 hover:text-secondary-foreground hover:border-secondary-foreground/20`
const activeClass = `${baseButtonClass} border-secondary-foreground/30 bg-secondary text-secondary-foreground`


/**
 * Compact keyboard hint badge in the corner of a tool button.
 */
const ShortcutHint = ({ shortcut }: { shortcut: string }) => (
  <span className="pointer-events-none absolute -bottom-1 -right-1 px-0 text-[9px] font-semibold leading-none text-muted-foreground/80">
    {shortcut}
  </span>
)


/** Board-level views available from the toolbar's leading menu. */
const VIEW_OPTIONS = [
  { id: "board" as const, label: "Board", icon: GraphViewIcon },
  { id: "files" as const, label: "Files", icon: GridViewIcon },
  { id: "list" as const, label: "List", icon: ListViewIcon },
]


type ToolbarPopupSide = "bottom" | "left" | "right"


/** Divider that follows the toolbar's horizontal or side-docked layout. */
function ToolbarSeparator({ dock }: { dock: ToolbarDock }) {
  const vertical = dock === "top"

  return (
    <Separator
      orientation={vertical ? "vertical" : "horizontal"}
      className={cn(
        "hidden md:block",
        vertical ? "md:!h-6" : "col-span-2 md:!h-px md:!w-8",
      )}
    />
  )
}


export function HarnessToolbar({ local = false }: { local?: boolean } = {}) {
  const tool = useBoardAppStore((s) => s.tool)
  const setTool = useBoardAppStore((s) => s.setTool)
  const inkColor = useBoardAppStore((s) => s.inkColor)
  const setInkColor = useBoardAppStore((s) => s.setInkColor)
  const inkSize = useBoardAppStore((s) => s.inkSize)
  const setInkSize = useBoardAppStore((s) => s.setInkSize)
  const chromeDialog = useBoardAppStore((s) => s.chromeDialog)
  const setChromeDialog = useBoardAppStore((s) => s.setChromeDialog)
  const slidesPanelOpen = useBoardAppStore((s) => s.slidesPanelOpen)
  const setSlidesPanelOpen = useBoardAppStore((s) => s.setSlidesPanelOpen)
  const viewMode = useBoardAppStore((s) => s.viewMode)
  const setViewMode = useBoardAppStore((s) => s.setViewMode)
  // Controlled so the trigger can show hover feedback normally and flip to the
  // active style only while its menu is open (uncontrolled gives no open signal
  // for styling, and the nested Tooltip/Dropdown triggers both write
  // `data-state`, so a `data-[state=open]:` variant would be ambiguous).
  const [viewMenuOpen, setViewMenuOpen] = useState(false)
  const [pencilSyncing, setPencilSyncing] = useState(false)
  const [dock, setDock] = useState<ToolbarDock>(() => readToolbarDock())

  useEffect(() => {
    document.documentElement.dataset.boardToolbarDock = dock
    return () => {
      if (document.documentElement.dataset.boardToolbarDock === dock) {
        delete document.documentElement.dataset.boardToolbarDock
      }
    }
  }, [dock])

  const changeDock = (nextDock: ToolbarDock): void => {
    setDock(nextDock)
    writeToolbarDock(nextDock)
    document.documentElement.dataset.boardToolbarDock = nextDock
    window.dispatchEvent(new Event(TOOLBAR_DOCK_CHANGE_EVENT))
  }

  /** Converts native ink, persists it, and gives the user one honest completion signal. */
  const syncNativePencil = async (): Promise<void> => {
    if (pencilSyncing) return
    setPencilSyncing(true)
    const toastId = toast.loading("正在同步手写…")

    try {
      const result = await requestNativePencilSync()
      const sync = getBoardSyncRef()
      if (sync) await sync.settle()
      else await getBoardPersistenceRef()?.flush()

      toast.success(
        sync
          ? `手写已保存并进入同步队列（${result.total} 笔）`
          : `手写已保存到本机（${result.total} 笔）`,
        { id: toastId },
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "手写同步失败，请重试。", { id: toastId })
    } finally {
      setPencilSyncing(false)
    }
  }

  const isBoard = viewMode === "board"
  const isPan = tool === "pan"
  const isSelect = tool === "select"
  const isShape = SHAPE_TOOL_IDS.has(tool)
  const ActiveShape = SHAPE_TOOLS.find((s) => s.id === tool)?.icon ?? ShapesMenuIcon
  const shapeMenuOpen = chromeDialog === "shape-menu"
  const activeView = VIEW_OPTIONS.find((v) => v.id === viewMode) ?? VIEW_OPTIONS[0]
  const ActiveViewIcon = activeView.icon
  const popupSide: ToolbarPopupSide = dock === "left"
    ? "right"
    : dock === "right"
      ? "left"
      : "bottom"

  return (
    <DockableToolbarTray
      dock={dock}
      onDockChange={changeDock}
      className="text-sidebar-foreground"
      role="toolbar"
      aria-label="Board toolbar"
      data-coachmark="toolbar"
    >
      <DropdownMenu open={viewMenuOpen} onOpenChange={setViewMenuOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Change view"
                aria-pressed={viewMenuOpen}
                className={cn(
                  viewMenuOpen ? activeClass : inactiveClass,
                  dock !== "top" && "col-span-2",
                )}
              >
                <ActiveViewIcon className="size-4 shrink-0" weight="fill" />
                <span className={cn("sr-only text-[10px]", dock === "top" && "md:not-sr-only")}>
                  {activeView.label}
                </span>
                <ChevronDownIcon
                  className={cn(
                    "hidden size-3 shrink-0 text-muted-foreground",
                    dock === "top" && "md:block",
                  )}
                />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side={popupSide} sideOffset={10}>Change view</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="start" side={popupSide} sideOffset={8} className="min-w-[160px]">
          {VIEW_OPTIONS.map((option) => {
            const Icon = option.icon
            return (
              <DropdownMenuItem
                key={option.id}
                onSelect={() => setViewMode(option.id)}
                className="gap-2 text-sm"
              >
                <Icon
                  className="size-4 shrink-0"
                  weight={option.id === viewMode ? "fill" : undefined}
                />
                <span>{option.label}</span>
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      <ToolbarSeparator dock={dock} />

      {/*
        Canvas-only tools are hidden in non-board view modes. The
        view dropdown and the More menu (create-only actions) stay
        visible everywhere so users can navigate + create from any
        surface.
      */}
      {isBoard && (
      <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setTool("pan")}
            aria-label="Pan"
            aria-pressed={isPan}
            className={isPan ? activeClass : inactiveClass}
          >
            <div className="relative">
              {isPan ? (
                <HandGrabIcon className="size-4 shrink-0" weight="fill" />
              ) : (
                <HandPanIcon className="size-4 shrink-0" />
              )}
              <ShortcutHint shortcut="P" />
            </div>
          </button>
        </TooltipTrigger>
        <TooltipContent side={popupSide} sideOffset={10}>Pan</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setTool("select")}
            aria-label="Select"
            aria-pressed={isSelect}
            className={isSelect ? activeClass : inactiveClass}
          >
            <div className="relative">
              <CursorSelectIcon
                className="size-4 shrink-0"
                weight={isSelect ? "fill" : undefined}
              />
              <ShortcutHint shortcut="V" />
            </div>
          </button>
        </TooltipTrigger>
        <TooltipContent side={popupSide} sideOffset={10}>Select</TooltipContent>
      </Tooltip>

      <div className={cn(
        "flex items-center",
        dock !== "top" && tool === "ink" && "col-span-2 justify-center",
      )}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setTool("ink")}
              aria-label="Pen"
              aria-pressed={tool === "ink"}
              className={tool === "ink" ? activeClass : inactiveClass}
            >
              <PencilEditIcon className="size-4 shrink-0" weight={tool === "ink" ? "fill" : undefined} />
            </button>
          </TooltipTrigger>
          <TooltipContent side={popupSide} sideOffset={10}>Pen</TooltipContent>
        </Tooltip>
        {tool === "ink" && (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="Pen settings"
                className="ml-0.5 flex size-6 items-center justify-center rounded-md hover:bg-secondary/60"
              >
                <span
                  className="size-3 rounded-full border border-foreground/20"
                  style={{ backgroundColor: inkColor }}
                />
              </button>
            </PopoverTrigger>
            <PopoverContent side={popupSide} sideOffset={10} className="w-56 space-y-4">
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>Color</span>
                <input
                  type="color"
                  value={inkColor}
                  onChange={(event) => setInkColor(event.target.value)}
                  className="h-8 w-12 cursor-pointer rounded border border-border bg-transparent p-0.5"
                />
              </label>
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span>Width</span>
                  <span className="text-muted-foreground">{inkSize}px</span>
                </div>
                <Slider
                  min={1}
                  max={24}
                  step={1}
                  value={[inkSize]}
                  onValueChange={([value]) => setInkSize(value)}
                  aria-label="Pen width"
                />
              </div>
            </PopoverContent>
          </Popover>
        )}
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setTool("eraser")}
            aria-label="Eraser"
            aria-pressed={tool === "eraser"}
            className={tool === "eraser" ? activeClass : inactiveClass}
          >
            <EraserIcon className="size-4 shrink-0" weight={tool === "eraser" ? "fill" : undefined} />
          </button>
        </TooltipTrigger>
        <TooltipContent side={popupSide} sideOffset={10}>Eraser</TooltipContent>
      </Tooltip>

      {isIOSNative() && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => void syncNativePencil()}
              disabled={pencilSyncing}
              aria-label="Sync handwriting"
              className={cn(inactiveClass, "disabled:cursor-wait disabled:opacity-60")}
            >
              <LoaderRefreshIcon className={cn("size-4 shrink-0", pencilSyncing && "animate-spin")} />
            </button>
          </TooltipTrigger>
          <TooltipContent side={popupSide} sideOffset={10}>同步手写</TooltipContent>
        </Tooltip>
      )}

      <ToolbarSeparator dock={dock} />

      <DropdownMenu
        open={shapeMenuOpen}
        onOpenChange={(open) => setChromeDialog(open ? "shape-menu" : null)}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Add shape"
                className={isShape ? activeClass : inactiveClass}
              >
                <div className="relative flex flex-col items-center gap-0.5">
                  <ActiveShape
                    className="size-4 shrink-0"
                    weight={isShape ? "fill" : undefined}
                  />
                  <ShortcutHint shortcut="S" />
                  <ChevronDownIcon
                    className={cn(
                      "absolute inset-x-0 -bottom-3.5 size-3 text-muted-foreground",
                      dock !== "top" && "hidden",
                    )}
                  />
                </div>
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side={popupSide} sideOffset={10}>Shapes</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="center" side={popupSide} sideOffset={8} className="min-w-[180px]">
          {SHAPE_TOOLS.map((s) => {
            const Icon = s.icon
            return (
              <DropdownMenuItem
                key={s.id}
                onSelect={() => setTool(s.id)}
                className="gap-2 text-sm"
              >
                <Icon className="size-4 shrink-0" />
                <span>{s.label}</span>
                {s.shortcut ? <DropdownMenuShortcut>{s.shortcut}</DropdownMenuShortcut> : null}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setTool("arrow")}
            aria-label="Connector"
            aria-pressed={tool === "arrow"}
            className={tool === "arrow" ? activeClass : inactiveClass}
          >
            <div className="relative">
              <ConnectorPathIcon
                className="size-4 shrink-0"
                weight={tool === "arrow" ? "fill" : undefined}
              />
              <ShortcutHint shortcut="A" />
            </div>
          </button>
        </TooltipTrigger>
        <TooltipContent side={popupSide} sideOffset={10}>Connector</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setTool("text")}
            aria-label="Text"
            aria-pressed={tool === "text"}
            className={tool === "text" ? activeClass : inactiveClass}
          >
            <div className="relative">
              <TextTIcon
                className="size-4 shrink-0"
                weight={tool === "text" ? "fill" : undefined}
              />
              <ShortcutHint shortcut="T" />
            </div>
          </button>
        </TooltipTrigger>
        <TooltipContent side={popupSide} sideOffset={10}>Text</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setTool("sheet")}
            aria-label="Note"
            aria-pressed={tool === "sheet"}
            className={cn(
              tool === "sheet" ? activeClass : inactiveClass,
              dock !== "top" && "col-span-2",
            )}
          >
            <div className="relative">
              <NotepadIcon
                className="size-4 shrink-0"
                weight={tool === "sheet" ? "fill" : undefined}
              />
              <ShortcutHint shortcut="N" />
            </div>
          </button>
        </TooltipTrigger>
        <TooltipContent side={popupSide} sideOffset={10}>Note</TooltipContent>
      </Tooltip>

      <ToolbarSeparator dock={dock} />

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setSlidesPanelOpen(!slidesPanelOpen)}
            aria-label="Slides"
            aria-pressed={slidesPanelOpen}
            className={cn(
              slidesPanelOpen ? activeClass : inactiveClass,
              dock !== "top" && "col-span-2",
            )}
          >
            <div className="relative">
              <PresentationIcon
                className="size-4 shrink-0"
                weight={slidesPanelOpen ? "fill" : undefined}
              />
              <ShortcutHint shortcut="M" />
            </div>
          </button>
        </TooltipTrigger>
        <TooltipContent side={popupSide} sideOffset={10}>Slides</TooltipContent>
      </Tooltip>

      <ToolbarSeparator dock={dock} />
      </>
      )}

      <HarnessToolbarMore local={local} side={popupSide} />
    </DockableToolbarTray>
  )
}
