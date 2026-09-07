// On-canvas view for a mini-app note.
//
// Wraps the host-side MiniAppMount (which owns the sandboxed iframe,
// state hydration, and RPC routing) with the standard canvas chrome:
// traffic lights for delete/expand, a label caption below the card.
// Iframe lifecycle: the iframe boots only when the node is in view AND the board
// camera is at rest — panning/scrolling at any speed mounts nothing new, so nodes
// crossed mid-scroll aren't booted — or immediately if it's kept alive from a
// recent visit (bounded LRU). Both come from useMiniAppMount (createDeferredMount).
// Once mounted it stays
// while in view OR retained, so a visible node is never torn down; nodes not yet
// mounted / beyond the LRU show a placeholder.
//
// Mirrors the shape of WidgetView in node-types/widget/view.tsx — the
// canvas chrome conventions live there.

import { useEffect, useRef } from "react"

import { CursorClickIcon } from "@phosphor-icons/react"
import { type NodeId } from "@canvas-harness/core"
import { useCanvasStore, useNode, useSelection } from "@canvas-harness/react"
import { removeNodeSubtree } from "@/features/board/harness/graph/subtree"

import { MiniAppMount, prefetchMiniAppRuntime } from "@/features/mini-app"
import { cn } from "@/lib/utils"

import type { NoteNodeData } from "../../convert/note-to-node"
import {
  createDeferredMount,
  NodeTitleCaption,
  NodeTrafficLights,
} from "../../shared-views"
import { useBoardAppStore } from "../../store/board-app-store"


// Retention pool for mini-app iframes — the heaviest node type (~5 MB each), so a
// small cap. Independent from other node types' pools (see createDeferredMount).
const useMiniAppMount = createDeferredMount({ cap: 8 })


export interface MiniAppViewProps {
  id: NodeId
}


/**
 * Canvas view for a mini-app note. Renders the iframe via MiniAppMount while the
 * node should stay mounted (deferred-mount: in view + camera at rest, or a
 * recently-retained node); otherwise shows a paused-state placeholder card so the
 * rest of the board stays responsive. Content scrolls inside the user-sized
 * card so loading an app cannot grow it over neighboring notes.
 */
export function MiniAppView({ id }: MiniAppViewProps) {
  const node = useNode(id)
  const store = useCanvasStore()
  const openNodeSurface = useBoardAppStore((s) => s.openNodeSurface)
  const canEdit = useBoardAppStore((s) => s.canEdit)
  const wrapRef = useRef<HTMLDivElement>(null)
  // Defer the heavy iframe mount until the node is in view AND the camera is at
  // rest; keep it while visible or recently-retained. See createDeferredMount.
  const { shouldMount, isInView } = useMiniAppMount(id as unknown as string, wrapRef)
  // Gate iframe interaction on selection so canvas pan/zoom gestures
  // pass cleanly through unselected mini-apps. Without this, the
  // iframe's `pointer-events-auto` captures the pointer the moment
  // the user's drag crosses into the card → canvas-harness loses
  // gesture tracking → pan dies mid-swipe. Same pattern sheet uses for
  // its inline editor (gated on `editing` instead of selection).
  const selection = useSelection()
  const isSelected = selection.includes(id)

  // A mini-app node exists on this board → warm the runtime cache on idle (once
  // per session) so the first open isn't a cold ~5 MB fetch, even for nodes that
  // are still below the fold.
  useEffect(() => {
    prefetchMiniAppRuntime()
  }, [])

  if (!node) return null

  const data = (node.data ?? {}) as Partial<NoteNodeData>
  const label = data.label?.markdown
  const source = node.content ?? ""

  return (
    <div
      ref={wrapRef}
      className="pointer-events-none relative h-full w-full select-none"
    >
      <div
        className={cn(
          "absolute inset-0 flex flex-col overflow-hidden rounded-2xl border border-dashed border-border bg-background px-2 pb-2 pt-10",
        )}
        // Kept-alive but off-screen: skip rendering this whole card subtree
        // (chrome + iframe) so the browser stops its render/paint work and can
        // throttle the iframe's rAF, while the iframe stays mounted (no re-parse).
        // Restores instantly on return. `inset-0` is explicit sizing, so
        // `contain: size` doesn't collapse the box. No-op on webviews without
        // content-visibility (older WebKit).
        style={{ contentVisibility: shouldMount && !isInView ? "hidden" : undefined }}
      >
        <div className="relative h-full w-full overflow-hidden rounded-xl border border-border/50 bg-background">
          {source && shouldMount ? (
            <MiniAppMount
              noteId={id as unknown as string}
              source={source}
              className={cn(
                "h-full w-full bg-transparent",
                isSelected ? "pointer-events-auto" : "pointer-events-none",
              )}
            />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center text-sm text-muted-foreground">
              <CursorClickIcon className="size-5 shrink-0" />
              <span>{source ? "Mini-app paused" : "Mini-app source will render here"}</span>
            </div>
          )}
        </div>
      </div>

      <NodeTrafficLights
        onDelete={canEdit ? () => removeNodeSubtree(store, id) : undefined}
        onExpand={canEdit ? () => openNodeSurface(id as unknown as string, "mini-app") : undefined}
      />

      <div className="pointer-events-auto absolute left-1/2 top-full z-20 mt-2 w-full -translate-x-1/2">
        <NodeTitleCaption
          nodeId={id}
          label={label}
          placeholder="Untitled mini-app"
          textClassName="text-center text-sm font-handwriting text-foreground"
        />
      </div>
    </div>
  )
}
