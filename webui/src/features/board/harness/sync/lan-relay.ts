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
      const response = await opts.exchange(cursor, [...outgoing.values()].slice(0, 100))
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
