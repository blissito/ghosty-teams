import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { CanvasEditor, htmlToDoc } from '@ghosty/canvas-editor'
import { StreamingHtmlFrame } from '../components/StreamingHtmlFrame'

// Banco de pruebas del EDITOR con un artefacto REAL del agente (mismo montaje que
// ArtifactPanel: tailwindPlay + extraCss con el CSS del artefacto reescrito a
// .ce-artboard y sin sus tokens). Sirve para reproducir sin sesión "el artboard sale
// en blanco" / "la paleta no aplica". Ruta pública de diagnóstico.
export const Route = createFileRoute('/canvas-probe')({ component: CanvasProbe })

const ARTIFACT = `<!doctype html><html data-theme="light"><head>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  :root {
    --color-background: #ffffff;
    --color-foreground: #111111;
    --color-primary: #7c3aed;
    --color-primary-foreground: #ffffff;
    --color-border: #e5e5e5;
    --radius: 14px;
  }
  .glow { box-shadow: 0 0 40px rgba(0,0,0,.15); }
</style></head>
<body>
  <section data-id="hero" class="flex min-h-[420px] flex-col items-center justify-center gap-6 px-8 py-20 text-center bg-[var(--color-primary)] text-[var(--color-primary-foreground)]">
    <h1 data-id="h1" class="text-5xl font-bold tracking-tight">Tu marca, redefinida.</h1>
    <p data-id="p" class="max-w-xl text-lg opacity-90">Estrategia, diseño y contenido.</p>
    <a data-id="cta" class="glow rounded-[var(--radius)] bg-[var(--color-background)] px-6 py-3 font-semibold text-[var(--color-primary)]">Solicitar cotización</a>
  </section>
</body></html>`

function StreamProbe() {
  // Simula al agente escribiendo el artefacto: alimenta el HTML de a poquito y deja que
  // StreamingHtmlFrame lo pinte. Sirve para comprobar que el preview se ARMA en vivo.
  const [n, setN] = useState(0)
  useEffect(() => {
    const iv = setInterval(() => setN((v) => Math.min(v + 90, ARTIFACT.length)), 120)
    return () => clearInterval(iv)
  }, [])
  return (
    <div style={{ position: 'fixed', inset: 0 }} data-stream-len={n}>
      <StreamingHtmlFrame html={ARTIFACT.slice(0, n)} title="probe" className="h-full w-full border-0" />
    </div>
  )
}

function CanvasProbe() {
  // El modo se decide DESPUÉS de montar (leer location en el primer render rompe la
  // hidratación: el SSR no ve el query string).
  const [mode, setMode] = useState<'editor' | 'stream'>('editor')
  useEffect(() => { if (window.location.search.includes('stream')) setMode('stream') }, [])
  // htmlToDoc necesita DOMParser → SOLO en cliente (en SSR reventaba el árbol y React
  // devolvía la frontera de Suspense en error: `<!--$!-->`, página en blanco).
  const [doc, setDoc] = useState<ReturnType<typeof htmlToDoc> | null>(null)
  useEffect(() => { setDoc(htmlToDoc(ARTIFACT)) }, [])
  const extraCss = useMemo(() => {
    const blocks = ARTIFACT.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || []
    return blocks
      .map((b) => b.replace(/<\/?style[^>]*>/gi, ''))
      .join('\n')
      .replace(/(^|[\s,{}])(html|body)\b/gi, '$1.ce-artboard')
      .replace(/:root\b/gi, '.ce-artboard')
      .replace(/^\s*--(?:color-[\w-]+|radius|font-(?:heading|body|mono))\s*:[^;]*;/gim, '')
  }, [])
  if (mode === 'stream') return <StreamProbe />
  if (!doc) return <div style={{ padding: 24 }}>cargando editor…</div>
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <CanvasEditor doc={doc} extraCss={extraCss} tailwindPlay />
    </div>
  )
}
