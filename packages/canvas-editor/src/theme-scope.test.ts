// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { htmlToDoc, docToHtml, themeToCss } from './serialize'
import { PALETTE_PRESETS } from './model'

// Artefacto tal como lo emite el agente: define SU PROPIA paleta en :root (autocontenido
// para su URL pública) y colorea con clases arbitrarias que leen esos tokens.
const ARTIFACT = `<!doctype html><html data-theme="light"><head><style>
  :root {
    --color-background: #ffffff;
    --color-foreground: #111111;
    --color-primary: #7c3aed;
    --color-primary-foreground: #ffffff;
    --color-border: #e5e5e5;
    --radius: 12px;
    --font-heading: Inter;
    --font-body: Inter;
  }
  @keyframes float { to { transform: translateY(-4px) } }
</style></head><body>
  <section data-id="hero" class="bg-[var(--color-primary)] text-[var(--color-primary-foreground)]">Hola</section>
</body></html>`

// Copia EXACTA de la transformación que hace ArtifactPanel al entrar a editar.
function toEditSurfaceCss(html: string): string {
  const blocks = html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || []
  return blocks
    .map((b) => b.replace(/<\/?style[^>]*>/gi, ''))
    .join('\n')
    .replace(/(^|[\s,{}])(html|body)\b/gi, '$1.ce-artboard')
    .replace(/:root\b/gi, '.ce-artboard')
    .replace(/^\s*--(?:color-[\w-]+|radius|font-(?:heading|body|mono))\s*:[^;]*;/gim, '')
}

describe('tema del artefacto dentro del editor', () => {
  it('la paleta del artefacto SIEMBRA el tema del editor', () => {
    const doc = htmlToDoc(ARTIFACT)
    expect(doc.theme.light.primary).toBe('#7c3aed')
    expect(doc.theme.radius).toBe('12px')
  })

  it('con scope, los tokens salen en .ce-artboard y NO en :root (no pisan la UI de Teams)', () => {
    const doc = htmlToDoc(ARTIFACT)
    const css = themeToCss(doc.theme, { scope: '.ce-artboard' })
    expect(css).toContain('.ce-artboard {')
    expect(css).toContain('--color-primary: #7c3aed;')
    expect(css).not.toContain(':root')
  })

  it('cambiar de paleta cambia los tokens emitidos (el selector del panel sirve)', () => {
    const doc = htmlToDoc(ARTIFACT)
    const before = themeToCss(doc.theme, { scope: '.ce-artboard' })
    const everforest = PALETTE_PRESETS.find((p) => p.name === 'Everforest')!
    const next = { ...doc.theme, light: everforest.light }
    const after = themeToCss(next, { scope: '.ce-artboard' })
    expect(after).not.toBe(before)
    expect(after).toContain(`--color-primary: ${everforest.light.primary};`)
    expect(after).not.toContain('#7c3aed')
  })

  it('el CSS del artefacto en edición pierde SOLO los tokens (conserva sus reglas)', () => {
    const css = toEditSurfaceCss(ARTIFACT)
    expect(css).not.toMatch(/--color-primary\s*:/)
    expect(css).not.toMatch(/--radius\s*:/)
    expect(css).toContain('@keyframes float')
    expect(css).not.toContain(':root') // reescrito a .ce-artboard
  })

  it('al exportar, el artefacto vuelve a llevar SU paleta en :root (autocontenido)', () => {
    const doc = htmlToDoc(ARTIFACT)
    const out = docToHtml(doc)
    expect(out).toContain(':root {')
    expect(out).toContain('--color-primary: #7c3aed;')
  })
})

describe('utilidades arbitrarias con tokens', () => {
  it('text-[var(--color-*)] genera COLOR, no font-size', async () => {
    const { arbitraryUtilityCss } = await import('./serialize')
    const doc = htmlToDoc(ARTIFACT)
    const css = arbitraryUtilityCss(doc, '.ce-artboard')
    expect(css).toMatch(/color:var\(--color-primary-foreground\)/)
    expect(css).not.toMatch(/font-size:var\(--color-/)
  })

  it('bg-[var(--color-*)] genera background-color', async () => {
    const { arbitraryUtilityCss } = await import('./serialize')
    const doc = htmlToDoc(ARTIFACT)
    expect(arbitraryUtilityCss(doc, '.ce-artboard')).toMatch(/background-color:var\(--color-primary\)/)
  })
})
