import { useEffect, useRef, useState } from "react"
import { useCanvasStore } from "@canvas-harness/react"
import { isIOSNative, isTauri } from "@/platform"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { getLocalStores } from "@/features/local-stores"
import { getBoardPersistenceRef } from "@/features/board/persist/local/board-persistence-ref"
import { getBoardSyncRef } from "../harness/sync/board-sync-ref"
import { captureLanSeed, importLanSeed, type LanSeed } from "./seed"
import { lanCommand, saveLanBinding, useLanBinding, useLanStatus, type LanBinding } from "./native"


type Invitation = { invitation: string; svg: string }
type Peer = { id: string; name: string; approved: boolean; revoked: boolean }


export function PairingDialog({ boardId, open, onOpenChange }: { boardId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const store = useCanvasStore()
  const binding = useLanBinding(boardId)
  const status = useLanStatus(boardId)
  const [addresses, setAddresses] = useState<string[]>([])
  const [address, setAddress] = useState("")
  const [invitation, setInvitation] = useState<Invitation | null>(null)
  const [peers, setPeers] = useState<Peer[]>([])
  const [code, setCode] = useState("")
  const [pending, setPending] = useState<LanBinding | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const active = useRef(false)
  const host = isTauri()
  const room = binding?.room

  useEffect(() => {
    if (!open || !host) return
    let cancelled = false
    void lanCommand<string[]>("addresses").then((list) => {
      if (cancelled) return
      setAddresses(list)
      setAddress((previous) => previous || list[0] || "")
    }).catch((e: unknown) => { if (!cancelled) setError(String(e)) })
    return () => { cancelled = true }
  }, [open, host])

  useEffect(() => {
    if (!open || !host || !room) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async (): Promise<void> => {
      try {
        const list = await lanCommand<Peer[]>("peers", { room })
        if (!cancelled) setPeers(list)
      } catch (e) { if (!cancelled) setError(String(e)) }
      if (!cancelled) timer = setTimeout(() => void refresh(), 2000)
    }
    void refresh()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [open, host, room])

  const run = async (action: () => Promise<void>): Promise<void> => {
    if (active.current) return
    active.current = true
    setBusy(true)
    setError("")
    try { await action() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { active.current = false; setBusy(false) }
  }

  const invite = async (): Promise<void> => {
    const server = await lanCommand<{ endpoint: string }>("start", { address: binding?.address ?? address })
    let current = binding
    if (!current) {
      const persistence = getBoardPersistenceRef()
      if (!persistence) throw new Error("画布尚未完成加载，请稍后重试")
      const stores = await getLocalStores()
      const meta = await stores.boards.getBoard(boardId)
      if (!meta || meta.kind !== "local-only") throw new Error("请选择本地画布")
      if (meta.lanRoom) throw new Error("原配对信息缺失，请恢复原设备配对资料后继续。")
      await persistence.flush()
      const capture = await persistence.capture()
      const seed = await captureLanSeed(stores.engine, meta, capture.content, capture.seq)
      const created = await lanCommand<{ room: string }>("create", { boardId, seed })
      const accepted = await lanCommand<{ seed: LanSeed }>("bootstrap", { room: created.room })
      if (!Number.isSafeInteger(accepted.seed.sourceSeq) || accepted.seed.sourceSeq > capture.seq) throw new Error("电脑副本早于配对快照，请恢复完整副本后再连接。")
      await persistence.foldBase(accepted.seed.content, accepted.seed.sourceSeq)
      await persistence.flush()
      current = { role: "host", room: created.room, clientId: store.clientId, endpoint: server.endpoint, address }
      await stores.boards.createBoard({ ...meta, lanRoom: created.room })
      saveLanBinding(boardId, current)
    }
    setInvitation(await lanCommand<Invitation>("invite", { room: current.room }))
  }

  const join = async (raw: string): Promise<void> => {
    const result = await lanCommand<Omit<LanBinding, "role">>("join", { invitation: raw })
    setPending({ ...result, role: "peer" })
  }

  const finishJoin = async (): Promise<void> => {
    if (!pending) return
    const { seed } = await lanCommand<{ seed: LanSeed }>("bootstrap", pending)
    const stores = await getLocalStores()
    await importLanSeed(stores.engine, seed, pending.room)
    saveLanBinding(seed.boardId, pending)
    await getBoardSyncRef()?.settle()
    await getBoardPersistenceRef()?.flush()
    window.location.assign(`/local/${encodeURIComponent(seed.boardId)}`)
  }

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
      <DialogHeader><DialogTitle>局域网配对</DialogTitle>
        <DialogDescription>电脑和 iPad 连接同一 Wi-Fi 或热点。保持 Dim0 电脑端运行；无互联网也能连接。</DialogDescription>
      </DialogHeader>
      {binding && <p role="status">{status} · {binding.endpoint}</p>}
      {host && <>
        {!binding && <label className="grid gap-2">电脑 Wi-Fi 地址
          <select className="rounded border p-2" value={address} onChange={(e) => setAddress(e.target.value)}>
            {addresses.map((ip) => <option key={ip}>{ip}</option>)}
          </select>
        </label>}
        <Button disabled={busy || (!binding && !address)} onClick={() => void run(invite)}>{invitation ? "重新生成配对码" : "生成配对码"}</Button>
        {invitation && <>
          <img className="mx-auto w-64 bg-white p-2" alt="iPad 配对二维码" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(invitation.svg)}`} />
          <p className="text-sm">配对码 10 分钟内有效，仅供一台设备使用。扫码后请在下方确认设备。</p>
          <details><summary>手动配对码</summary><textarea className="mt-2 w-full rounded border p-2" readOnly value={invitation.invitation} aria-label="电脑配对码" /></details>
        </>}
        {peers.map((peer) => <div key={peer.id} className="flex items-center justify-between gap-3 rounded border p-3">
          <span>{peer.name} · {peer.revoked ? "已撤销" : peer.approved ? "已授权" : "等待确认"}</span>
          {!peer.revoked && <Button disabled={busy} variant="outline" onClick={() => void run(async () => {
            await lanCommand("approve", { room, peer: peer.id, allowed: !peer.approved })
            setPeers(await lanCommand<Peer[]>("peers", { room }))
          })}>{peer.approved ? "撤销授权" : "允许连接"}</Button>}
        </div>)}
      </>}
      {isIOSNative() && <>
        <Button disabled={busy} onClick={() => void run(async () => { const raw = await lanCommand<string>("scan"); setCode(raw); await join(raw) })}>扫描电脑配对码</Button>
        <textarea className="min-h-24 rounded border p-2" value={code} onChange={(e) => setCode(e.target.value)} placeholder="也可以粘贴电脑端的完整配对码" aria-label="配对码" />
        <Button variant="outline" disabled={busy || !code.trim()} onClick={() => void run(() => join(code.trim()))}>使用粘贴的配对码</Button>
        {pending && <><p>请在电脑上允许“Dim0 iPad”连接，然后导入画布。</p><Button disabled={busy} onClick={() => void run(finishJoin)}>已在电脑确认，导入画布</Button></>}
      </>}
      {!host && !isIOSNative() && <p>请使用新版 Dim0 电脑端或 iPad App。浏览器暂不支持离线扫码连接。</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <p className="text-xs text-muted-foreground">无法连接时，检查本地网络权限、电脑防火墙，以及 Wi-Fi 是否禁止设备互访。</p>
    </DialogContent>
  </Dialog>
}
