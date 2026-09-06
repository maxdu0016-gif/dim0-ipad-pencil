import { isIOSNative, isTauri } from "@/platform"
import { useSyncExternalStore } from "react"


export type LanBinding = {
  role: "host" | "peer"
  room: string
  clientId: string
  endpoint: string
  address?: string
  connectionId?: string
}


const KEY = "dim0.lan.bindings"
const CHANGE = "dim0:lan-bindings"


/** Native-only LAN calls; no browser fallback may bypass certificate verification. */
export async function lanCommand<T>(action: string, body: object = {}): Promise<T> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core")
    return invoke<T>("lan_command", { action, body })
  }
  const native = window as unknown as {
    webkit?: { messageHandlers?: { dim0Lan?: { postMessage: (body: object) => Promise<T> } } }
  }
  if (isIOSNative() && native.webkit?.messageHandlers?.dim0Lan) {
    return native.webkit.messageHandlers.dim0Lan.postMessage({ action, body })
  }
  throw new Error("离线配对需要新版 Dim0 电脑端或 iPad App。")
}


/** Bindings contain opaque native references, never pairing secrets or API keys. */
export function readLanBinding(boardId: string | null): LanBinding | null {
  if (!boardId) return null
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "{}")[boardId] as LanBinding | undefined
    return value && (value.role === "host" || value.role === "peer")
      && typeof value.room === "string" && typeof value.clientId === "string" ? value : null
  } catch { return null }
}


export function saveLanBinding(boardId: string, binding: LanBinding | null): void {
  let all: Record<string, LanBinding> = {}
  try { all = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, LanBinding> } catch { /* Replace corrupt metadata only. */ }
  if (binding) all[boardId] = binding
  else delete all[boardId]
  localStorage.setItem(KEY, JSON.stringify(all))
  window.dispatchEvent(new Event(CHANGE))
}


const subscribe = (callback: () => void): (() => void) => {
  window.addEventListener(CHANGE, callback)
  window.addEventListener("storage", callback)
  return () => {
    window.removeEventListener(CHANGE, callback)
    window.removeEventListener("storage", callback)
  }
}


export function useLanBinding(boardId: string | null): LanBinding | null {
  useSyncExternalStore(subscribe, () => localStorage.getItem(KEY), () => null)
  return readLanBinding(boardId)
}


const states = new Map<string, string>()


export function setLanStatus(boardId: string, status: string): void {
  if (states.get(boardId) === status) return
  states.set(boardId, status)
  window.dispatchEvent(new Event(CHANGE))
}


export function useLanStatus(boardId: string): string {
  return useSyncExternalStore(subscribe, () => states.get(boardId) ?? "等待连接", () => "等待连接")
}
