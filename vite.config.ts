import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

const config = defineConfig({
  resolve: { tsconfigPaths: true },
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
