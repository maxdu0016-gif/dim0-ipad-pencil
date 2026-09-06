import { defineConfig } from "vite"
import react from "@vitejs/plugin-react-swc"
import tailwindcss from "@tailwindcss/vite"
import base from "./vite.config"


/** A self-contained native shell, loaded under the existing HTTPS storage origin. */
export default defineConfig({
  define: base.define,
  resolve: base.resolve,
  plugins: [react(), tailwindcss(), {
    name: "native-offline-no-service-worker",
    resolveId(id) { if (id === "virtual:pwa-register") return "\0native-offline-pwa" },
    load(id) { if (id === "\0native-offline-pwa") return "export const registerSW = () => async () => {}" },
  }],
  build: {
    outDir: "../ios-native/offline-build",
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})
