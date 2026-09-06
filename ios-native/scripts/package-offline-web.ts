import { readFile, writeFile, mkdir } from "node:fs/promises"
import { resolve, dirname, basename } from "node:path"
import { fileURLToPath } from "node:url"


const nativeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const build = resolve(nativeRoot, "offline-build")
let html = await readFile(resolve(build, "index.html"), "utf8")
for (const match of [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g)]) {
  const source = resolve(build, match[1].replace(/^\//, ""))
  if (!source.startsWith(build + "/") && !source.startsWith(build + "\\")) throw new Error("Invalid resource path")
  const js = await readFile(source, "utf8")
  const module = match[0].includes('type="module"') ? ' type="module"' : ""
  html = html.replace(match[0], () => `<script${module}>${js.replace(/<\/script/gi, "<\\/script")}</script>`)
}
for (const match of [...html.matchAll(/<link\b[^>]*\bhref="([^"]+\.css)"[^>]*>/g)]) {
  const css = await readFile(resolve(build, "assets", basename(match[1])), "utf8")
  html = html.replace(match[0], () => `<style>${css.replace(/<\/style/gi, "<\\/style")}</style>`)
}
html = html.replace(/<link\b[^>]*rel="modulepreload"[^>]*>/g, "")
const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (tag) => tag.slice(0, tag.indexOf(">") + 1))
if (/<script\b[^>]*\bsrc=|<link\b[^>]*rel="stylesheet"/i.test(markup)) throw new Error("Offline shell still requires external code")
const target = resolve(nativeRoot, "Dim0Native/Resources/offline-app.html")
await mkdir(dirname(target), { recursive: true })
await writeFile(target, html)
console.log(`Packaged offline shell (${Buffer.byteLength(html)} bytes)`)
