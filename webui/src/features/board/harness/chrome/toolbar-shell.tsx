import { useEffect, useRef, useState } from "react"
import { DotsSixVerticalIcon } from "@phosphor-icons/react"

import { cn } from "@/lib/utils"
import { isWebKitWebview } from "@/platform"
import {
  nearestToolbarDock,
  type ToolbarDock,
  type ToolbarDockBounds,
} from "./toolbar-dock"


const TRAY_HEIGHT = 46
const TRAY_RADIUS = 13
const SIDE_DOCK_TOP_CLEARANCE = 56
const SIDE_DOCK_BOTTOM_CLEARANCE = 164


type ToolbarDragState = {
  bounds: ToolbarDockBounds
  originX: number
  originY: number
  pointerId: number
  x: number
  y: number
}


/** Builds the flared SVG silhouette used while the toolbar is top-docked. */
function trayPath(width: number, height: number, radius: number): string {
  return `M0 0 A${radius} ${radius} 0 0 1 ${radius} ${radius}`
    + ` L${radius} ${height - radius} A${radius} ${radius} 0 0 0 ${2 * radius} ${height}`
    + ` L${width - 2 * radius} ${height} A${radius} ${radius} 0 0 0 ${width - radius} ${height - radius}`
    + ` L${width - radius} ${radius} A${radius} ${radius} 0 0 1 ${width} 0`
}


/**
 * Dockable toolbar shell. It keeps the flared tray at the top and switches to
 * a compact, scrollable two-column palette on either side of the canvas.
 */
export function DockableToolbarTray({
  children,
  className,
  dock,
  onDockChange,
  style,
  ...rest
}: {
  children: React.ReactNode
  dock: ToolbarDock
  onDockChange: (dock: ToolbarDock) => void
} & React.HTMLAttributes<HTMLDivElement>) {
  const outerRef = useRef<HTMLDivElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState(false)
  const [dragState, setDragState] = useState<ToolbarDragState | null>(null)
  const webkit = isWebKitWebview()
  const sideDocked = dock !== "top"

  useEffect(() => {
    const element = rowRef.current
    if (!element) return
    // offsetWidth includes the row padding, keeping the SVG around every button.
    const observer = new ResizeObserver(() => setWidth(element.offsetWidth))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const path = dock === "top" && width > 0
    ? trayPath(width, TRAY_HEIGHT, TRAY_RADIUS)
    : ""
  const dockPositionClass = dock === "top"
    ? "absolute left-1/2 top-0 -translate-x-1/2"
    : dock === "left"
      ? "absolute left-2 -translate-y-1/2"
      : "absolute right-2 -translate-y-1/2"
  const positionStyle: React.CSSProperties = sideDocked
    ? {
        top: `calc(${SIDE_DOCK_TOP_CLEARANCE}px + (100% - ${SIDE_DOCK_TOP_CLEARANCE + SIDE_DOCK_BOTTOM_CLEARANCE}px) / 2)`,
      }
    : {}

  const beginDrag = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (!event.isPrimary || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    const parentRect = outerRef.current?.offsetParent?.getBoundingClientRect()
    setDragState({
      bounds: parentRect
        ? { left: parentRect.left, top: parentRect.top, width: parentRect.width }
        : { left: 0, top: 0, width: window.innerWidth },
      originX: event.clientX,
      originY: event.clientY,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    })
  }

  const continueDrag = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (!dragState || event.pointerId !== dragState.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    setDragState((current) => current
      ? { ...current, x: event.clientX, y: event.clientY }
      : null)
  }

  const finishDrag = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (!dragState || event.pointerId !== dragState.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    onDockChange(nearestToolbarDock(
      { x: event.clientX, y: event.clientY },
      dragState.bounds,
    ))
    setDragState(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const cancelDrag = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (!dragState || event.pointerId !== dragState.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    setDragState(null)
  }

  const losePointerCapture = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (dragState?.pointerId === event.pointerId) setDragState(null)
  }

  const moveWithKeyboard = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    const nextDock = event.key === "ArrowUp"
      ? "top"
      : event.key === "ArrowLeft"
        ? "left"
        : event.key === "ArrowRight"
          ? "right"
          : null
    if (!nextDock) return
    event.preventDefault()
    onDockChange(nextDock)
  }

  return (
    <div
      ref={outerRef}
      className={cn("z-50", dockPositionClass, className)}
      style={{ ...style, ...positionStyle }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      {...rest}
      data-toolbar-dock={dock}
      data-native-pencil-passthrough=""
      aria-orientation={dock === "top" ? "horizontal" : "vertical"}
    >
      <div
        className={cn(
          "relative",
          sideDocked && "rounded-2xl border border-border bg-sidebar/95",
          sideDocked && (hover ? "shadow-xl" : "shadow-md"),
        )}
        style={dragState
          ? {
              transform: `translate3d(${dragState.x - dragState.originX}px, ${dragState.y - dragState.originY}px, 0)`,
            }
          : undefined}
      >
        {path && (
          <>
            {!webkit && (
              <div
                className="pointer-events-none absolute inset-0 backdrop-blur-xl backdrop-saturate-[1.8]"
                style={{ clipPath: `path('${path}')` }}
              />
            )}
            <div
              className={cn(
                "pointer-events-none absolute inset-0",
                webkit ? "bg-sidebar/95" : "bg-sidebar/60",
              )}
              style={{
                clipPath: `path('${path}')`,
                filter: hover
                  ? "drop-shadow(0 10px 22px rgba(0,0,0,0.22))"
                  : "drop-shadow(0 2px 5px rgba(0,0,0,0.10))",
                transition: "filter .2s ease",
              }}
            />
            <svg
              className="pointer-events-none absolute inset-0"
              width={width}
              height={TRAY_HEIGHT}
              style={{ overflow: "visible" }}
              aria-hidden
            >
              <path d={path} fill="none" stroke="var(--border)" strokeWidth={1} />
            </svg>
          </>
        )}
        <div
          ref={rowRef}
          className={cn(
            "relative items-center gap-1",
            dock === "top"
              ? "flex px-[18px]"
              : "grid grid-cols-2 place-items-center overflow-y-auto overscroll-contain p-2",
          )}
          style={dock === "top"
            ? { height: TRAY_HEIGHT }
            : {
                maxHeight: `calc(100dvh - ${SIDE_DOCK_TOP_CLEARANCE + SIDE_DOCK_BOTTOM_CLEARANCE}px)`,
              }}
        >
          <button
            type="button"
            data-native-pencil-passthrough=""
            data-toolbar-drag-handle=""
            aria-label={`Move toolbar. Current position: ${dock}`}
            title="Drag toolbar to the top, left, or right edge"
            className={cn(
              "touch-none shrink-0 cursor-grab rounded-md text-muted-foreground hover:bg-secondary/60 hover:text-secondary-foreground active:cursor-grabbing",
              dock === "top"
                ? "absolute left-1/2 top-full z-10 flex size-11 -translate-x-1/2 items-center justify-center rounded-t-none rounded-b-xl border-x border-b border-border bg-sidebar/95 shadow-sm"
                : "col-span-2 flex h-11 w-full items-center justify-center",
            )}
            onPointerDown={beginDrag}
            onPointerMove={continueDrag}
            onPointerUp={finishDrag}
            onPointerCancel={cancelDrag}
            onLostPointerCapture={losePointerCapture}
            onKeyDown={moveWithKeyboard}
          >
            <DotsSixVerticalIcon className={cn("size-4", sideDocked && "rotate-90")} />
          </button>
          {children}
        </div>
      </div>
    </div>
  )
}
