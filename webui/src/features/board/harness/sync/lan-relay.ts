import type { InboundMessage, OutboundMessage, RelayConnection } from "./wire"


export type LanExchange = {
  cursor: number
  latest: number
  messages: InboundMessage[]
}


type Options = {
  sinceSeq: number
  exchange: (since: number, messages: OutboundMessage[]) => Promise<LanExchange>
  onState: (state: "connected" | "reconnecting", error?: string) => void
  intervalMs?: number
}


/** Native HTTPS polling transport; edits remain queued until the durable relay acknowledges them. */
export function createLanRelay(opts: Options): RelayConnection {
  let cursor = opts.sinceSeq
  let closed = false
  let welcomed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let listener: ((message: InboundMessage) => void) | null = null
  const outgoing = new Map<number, OutboundMessage>()

  const poll = async (): Promise<void> => {
    if (closed || !listener) return
    let delay = opts.intervalMs ?? 400
    try {
      // Several image edits can exceed the native HTTP limit even when each edit fits individually.
      const sending: OutboundMessage[] = []
      let bytes = 0
      for (const message of outgoing.values()) {
        const size = new TextEncoder().encode(JSON.stringify(message)).byteLength
        if (size > 24 * 1024 * 1024) throw new Error("单次修改过大，请缩小图片后重试")
        if (sending.length === 100 || bytes + size > 24 * 1024 * 1024) break
        sending.push(message)
        bytes += size
      }
      const response = await opts.exchange(cursor, sending)
      if (closed) return
      if (!Number.isSafeInteger(response.cursor) || response.cursor < cursor
        || !Number.isSafeInteger(response.latest) || response.latest < response.cursor
        || !Array.isArray(response.messages)) throw new Error("Invalid local relay response")
      for (const message of response.messages) {
        listener(message)
        if (message.kind === "op-applied") outgoing.delete(message.client_seq)
      }
      cursor = response.cursor
      if (cursor === response.latest && !welcomed) {
        welcomed = true
        listener({ kind: "welcome", mode: "live", seq: cursor })
      }
      if (cursor === response.latest) opts.onState("connected")
      if (cursor < response.latest) delay = 0
    } catch (error) {
      if (!closed) opts.onState("reconnecting", error instanceof Error ? error.message : "Local connection unavailable")
      delay = 2000
    } finally {
      if (!closed) timer = setTimeout(() => void poll(), delay)
    }
  }

  return {
    send(message) {
      if (!closed && message.kind === "op") outgoing.set(message.client_seq, message)
    },
    onMessage(callback) {
      listener = callback
      timer = setTimeout(() => void poll(), 0)
      return () => { listener = null }
    },
    close() {
      closed = true
      clearTimeout(timer)
      listener = null
    },
  }
}
