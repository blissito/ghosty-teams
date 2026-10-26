import { defineConfig } from "vitest/config"
import viteReact from "@vitejs/plugin-react"

// Config de pruebas aparte de vite.config.ts: los plugins de la app (TanStack Start, Nitro,
// devtools, Tailwind) no sirven en vitest y el de Start rompía la resolución de módulos
// («Cannot find module …/react-start/dist/esm/index.js» aunque el archivo existe).
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: [{ find: /^buffer\/$/, replacement: "buffer/index.js" }],
  },
  plugins: [viteReact()],
  test: {
    // Sin .env: el tenant por defecto de las pruebas es uno de juguete, nunca uno real.
    env: { SQLD_NAMESPACE: "test" },
    // Mismo motivo que `ssr.noExternal` en vite.config.ts: el alias de `buffer/` sólo llega
    // a un paquete que vite procesa.
    server: { deps: { inline: ["@blocknote/xl-docx-exporter"] } },
  },
})
