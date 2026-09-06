import { afterEach, expect, it, vi } from "vitest"
import { asBatchId, asClientId, asNodeId } from "@canvas-harness/core"
import { createLanRelay } from "./lan-relay"
import type { InboundMessage, OutboundMessage } from "./wire"


afterEach(() => vi.useRealTimers())


it("sends a large offline image queue in bounded requests without dropping later edits", async () => {
  vi.useFakeTimers()
  const payload = "x".repeat(10 * 1024 * 1024)
  const exchange = vi.fn(async (_since: number, messages: OutboundMessage[]) => ({
    cursor: 3, latest: 3,
    messages: messages.flatMap((m) => m.kind === "op" ? [{ kind: "op-applied" as const, seq: m.client_seq, client_seq: m.client_seq }] : []),
  }))
  const relay = createLanRelay({ sinceSeq: 0, exchange, onState: vi.fn() })
  for (let id = 1; id <= 3; id++) relay.send({ kind: "op", client_seq: id, batch: {
    id: asBatchId(String(id)), clientId: asClientId("ipad"), ts: id, origin: "local",
    ops: [{ type: "node.update", id: asNodeId("image"), patch: { data: { payload } }, prev: {} }],
  } })
  relay.onMessage(() => {})
  await vi.advanceTimersByTimeAsync(401)
  expect(exchange.mock.calls.map((call) => call[1].length)).toEqual([2, 1])
  relay.close()
})


it("retries an unacknowledged edit and preserves relay order before notifying readiness", async () => {
  vi.useFakeTimers()
  const edit: OutboundMessage = {
    kind: "op", client_seq: 1,
    batch: { id: asBatchId("b"), clientId: asClientId("ipad"), ts: 1, origin: "local", ops: [
      { type: "node.update", id: asNodeId("n"), patch: { x: 10 }, prev: { x: 0 } },
    ] },
  }
  const exchange = vi.fn()
    .mockRejectedValueOnce(new Error("Disconnected"))
    .mockResolvedValueOnce({ cursor: 1, latest: 2, messages: [{ kind: "op-applied", seq: 1, client_seq: 1 }] })
    .mockResolvedValue({ cursor: 2, latest: 2, messages: [] })
  const received: InboundMessage[] = []
  const relay = createLanRelay({ sinceSeq: 0, exchange, onState: vi.fn() })
  relay.send(edit)
  relay.onMessage((m) => received.push(m))
  await vi.advanceTimersByTimeAsync(1)
  await vi.advanceTimersByTimeAsync(2001)
  expect(exchange.mock.calls[0][1]).toEqual([edit])
  expect(exchange.mock.calls[1][1]).toEqual([edit])
  expect(exchange.mock.calls[2][1]).toEqual([])
  expect(received.map((m) => m.kind)).toEqual(["op-applied", "welcome"])
  relay.close()
  const calls = exchange.mock.calls.length
  await vi.advanceTimersByTimeAsync(3000)
  expect(exchange).toHaveBeenCalledTimes(calls)
})
