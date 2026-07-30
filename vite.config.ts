import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

const config = defineConfig({
  resolve: {
    tsconfigPaths: true,
    // `@blocknote/xl-docx-exporter` hace `import("buffer/")` (con barra: el polyfill de
    // navegador) para cargar las fuentes que hornea en el .docx. Node en ESM NO resuelve
    // un directorio, así que el export moría con "Directory import ... is not supported".
    // Se apunta al archivo real; el polyfill YA está en node_modules (es dependencia suya).
    alias: [{ find: /^buffer\/$/, replacement: "buffer/index.js" }],
  },
  // Y hay que PROCESARLO para que el alias de arriba llegue a ese import: un paquete
  // tratado como externo lo carga Node directo y vite no reescribe nada dentro.
  ssr: { noExternal: ["@blocknote/xl-docx-exporter"] },
  plugins: [
    devtools(),
    // jsdom EXTERNAL: bundlearlo a ESM rompe en runtime con "__dirname is not defined"
    // (usa CJS internamente) y el estampado de data-id fallaba en silencio → el artefacto
    // se guardaba sin direcciones y el agente seguía re-emitiéndolo entero. Vive en el
    // node_modules de la caja, así que el import nativo lo resuelve.
    nitro({ rollupConfig: { external: [/^@sentry\//, "sharp", "jsdom"] } }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})

export default config
