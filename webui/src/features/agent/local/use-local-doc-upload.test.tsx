import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { useLocalDocUpload, type LocalDocUpload } from "./use-local-doc-upload"


const mocks = vi.hoisted(() => ({
  findByTitle: vi.fn(async () => undefined as { id: string } | undefined),
  parse: vi.fn(async () => ({ markdown: "Document text", pages: 1 })),
  ingest: vi.fn(async () => ({ docId: "doc1", chunks: 1, replaced: false })),
  addNode: vi.fn(),
}))
vi.mock("@/lib/auth", () => ({ useIsSignedIn: () => false }))
vi.mock("@/features/agent/byok/byok-store", () => ({ useByokStore: () => "" }))
vi.mock("@/features/local-stores", () => ({ getLocalStores: async () => ({ docs: { findByTitle: mocks.findByTitle } }) }))
vi.mock("@/features/board/harness/canvas-store-ref", () => ({ getCanvasStoreRef: () => ({}) }))
vi.mock("@/features/board/harness/agent/doc-node", () => ({ addDocumentNode: mocks.addNode }))
vi.mock("@/features/agent/engine/doc-parse", () => ({ resolveParseClient: () => null }))
vi.mock("./office-document", () => ({ DOCUMENT_ACCEPT: ".docx,.pptx,.pdf", documentExtension: (f: File) => f.name.split(".").pop(), parseOfficeDocument: mocks.parse }))
vi.mock("./ingest-doc", () => ({ ingestDocument: mocks.ingest }))
vi.mock("@/components/icons", () => ({ CircleNotchIcon: () => null, CloseIcon: () => null }))


it("imports Office without a parsing key, places at the drop point and waits for replacement approval", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previous = globals.IS_REACT_ACT_ENVIRONMENT
  globals.IS_REACT_ACT_ENVIRONMENT = true
  let upload: LocalDocUpload
  function Harness() {
    upload = useLocalDocUpload("board1")
    return upload.elements
  }
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    act(() => root.render(<Harness />))
    await act(async () => { await upload.importFile(new File(["text"], "notes.docx"), { x: 100, y: 200 }) })
    expect(mocks.ingest).toHaveBeenCalledWith(expect.objectContaining({ boardId: "board1", markdown: "Document text" }))
    expect(mocks.addNode).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ position: { x: 100, y: 200 } }))
    mocks.findByTitle.mockResolvedValue({ id: "doc1" })
    let pending: Promise<void>
    await act(async () => { pending = upload.importFile(new File(["new"], "notes.docx")) })
    expect(mocks.parse).toHaveBeenCalledTimes(1)
    const cancel = [...document.querySelectorAll("button")].find((button) => button.textContent === "Cancel")!
    await act(async () => { cancel.click(); await pending })
    expect(mocks.ingest).toHaveBeenCalledTimes(1)
  } finally {
    act(() => root.unmount())
    container.remove()
    globals.IS_REACT_ACT_ENVIRONMENT = previous
  }
})
