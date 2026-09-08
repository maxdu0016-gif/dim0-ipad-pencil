import { unzipSync, strFromU8 } from "fflate"
import type { ParseResponse } from "../engine/doc-parse"


export const DOCUMENT_ACCEPT = ".pdf,.docx,.pptx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation"


/** Identify supported files even when iPad's Files app supplies an empty MIME type. */
export const documentExtension = (file: File): string => file.name.split(".").pop()?.toLowerCase() ?? ""


/** Extract Office text without sending the document to a parsing service. */
export const parseOfficeDocument = async (file: File): Promise<ParseResponse> => {
  const extension = documentExtension(file)
  let total = 0
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()), {
    filter: (entry) => {
      const wanted = extension === "docx"
        ? /^word\/(document|footnotes|endnotes|header\d+|footer\d+)\.xml$/.test(entry.name)
        : /^(ppt\/slides\/slide\d+\.xml|ppt\/presentation\.xml|ppt\/_rels\/presentation\.xml.rels)$/.test(entry.name)
      if (!wanted) return false
      total += entry.originalSize
      if (total > 20 * 1024 * 1024) throw new Error("Document text is too large to import.")
      return true
    },
  })
  const xml = (path: string): Document => {
    if (!files[path]) throw new Error("Invalid or encrypted Office document.")
    const doc = new DOMParser().parseFromString(strFromU8(files[path]), "application/xml")
    if (doc.getElementsByTagName("parsererror").length) throw new Error("Invalid Office document XML.")
    return doc
  }
  let paths: string[]
  if (extension === "docx") {
    xml("word/document.xml")
    paths = ["word/document.xml", ...Object.keys(files).filter((p) => p !== "word/document.xml").sort()]
  } else {
    // Presentation order is defined by relationships, not slide filenames.
    const relations = Array.from(xml("ppt/_rels/presentation.xml.rels").getElementsByTagNameNS("*", "Relationship"))
    paths = Array.from(xml("ppt/presentation.xml").getElementsByTagNameNS("*", "sldId")).map((slide) => {
      const id = slide.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id")
      const target = relations.find((r) => r.getAttribute("Id") === id)?.getAttribute("Target") ?? ""
      const path = target.startsWith("/ppt/") ? target.slice(1) : `ppt/${target}`
      if (!/^ppt\/slides\/slide\d+\.xml$/.test(path)) throw new Error("Invalid slide relationship.")
      return path
    })
  }
  const sections = paths.map((path, index) => {
    const paragraphs = Array.from(xml(path).getElementsByTagNameNS("*", "p"))
    const text = paragraphs.map((p) => Array.from(p.getElementsByTagNameNS("*", "t")).map((t) => t.textContent ?? "").join("")).filter(Boolean).join("\n\n")
    return extension === "pptx" && text ? `## Slide ${index + 1}\n\n${text}` : text
  })
  return { markdown: sections.filter(Boolean).join("\n\n"), pages: extension === "pptx" ? paths.length : 1 }
}
