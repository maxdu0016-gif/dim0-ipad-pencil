import { describe, expect, it } from "vitest"
import { strToU8, zipSync } from "fflate"
import { parseOfficeDocument } from "./office-document"


/** Build a real ZIP container while retaining jsdom-compatible File methods. */
const officeFile = (name: string, entries: Record<string, string>): File => {
  const bytes = zipSync(Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, strToU8(value)])))
  return { name, arrayBuffer: async () => bytes.buffer } as File
}


describe("Office text for document Q&A", () => {
  it("reads split Word runs and table cells, without treating embedded images as text", async () => {
    const result = await parseOfficeDocument(officeFile("笔记.docx", {
      "word/document.xml": '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>你好</w:t></w:r><w:r><w:t>世界</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格数据</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
      "word/media/image.png": "not text",
    }))
    expect(result.markdown).toBe("你好世界\n\n表格数据")
  })

  it("reads PowerPoint in presentation order instead of filename order", async () => {
    const result = await parseOfficeDocument(officeFile("slides.pptx", {
      "ppt/presentation.xml": '<p:presentation xmlns:p="urn:p" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId r:id="r2"/><p:sldId r:id="r1"/></p:sldIdLst></p:presentation>',
      "ppt/_rels/presentation.xml.rels": '<Relationships><Relationship Id="r1" Target="slides/slide1.xml"/><Relationship Id="r2" Target="slides/slide2.xml"/></Relationships>',
      "ppt/slides/slide1.xml": '<a:p xmlns:a="urn:a"><a:r><a:t>Second</a:t></a:r></a:p>',
      "ppt/slides/slide2.xml": '<a:p xmlns:a="urn:a"><a:r><a:t>First</a:t></a:r></a:p>',
    }))
    expect(result).toEqual({ markdown: "## Slide 1\n\nFirst\n\n## Slide 2\n\nSecond", pages: 2 })
  })

  it("rejects corrupt files and leaves image-only content empty", async () => {
    await expect(parseOfficeDocument(officeFile("broken.docx", {}))).rejects.toThrow("Invalid")
    const result = await parseOfficeDocument(officeFile("image.docx", { "word/document.xml": '<w:document xmlns:w="urn:w"><w:p/></w:document>' }))
    expect(result.markdown).toBe("")
  })
})
