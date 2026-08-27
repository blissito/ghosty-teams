// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { htmlToDoc, docToHtml, themeToCss, shellStyleCss } from './serialize'
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

// El CSS del artefacto en la superficie de edición. Era una copia manual del regex de
// ArtifactPanel; ahora usa la función REAL del paquete, así que estos tests prueban de
// verdad lo que corre en producción en vez de una réplica que podía divergir.
function toEditSurfaceCss(html: string): string {
  return shellStyleCss(htmlToDoc(html).shell, { scope: '.ce-artboard' })
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

  // Regresión: emitía `background-color:url(…)` — inválido, el navegador lo tira,
  // y la foto de fondo se veía en el sitio publicado pero no en el lienzo.
  it('bg-[url(…)] genera background-image y respeta los guiones bajos de la URL', async () => {
    const { arbitraryUtilityCss, htmlToDoc: h } = await import('./serialize')
    const doc = h('<div data-artboard-name="A"><div class="bg-[url(/img/hero_bg.jpg)]"></div></div>')
    const css = arbitraryUtilityCss(doc, '.ce-artboard')
    expect(css).toMatch(/background-image:url\(\/img\/hero_bg\.jpg\)/)
    expect(css).not.toMatch(/background-color:url/)
  })
})

describe('HTML exportado', () => {
  it('un solo frame sale full-bleed (sin ancho fijo ni franja en pantallas anchas)', () => {
    const doc = htmlToDoc(ARTIFACT)
    const out = docToHtml(doc)
    const style = /<section[^>]*style="([^"]*)"/.exec(out)?.[1] ?? ''
    expect(style).toContain('width:100%')
    expect(style).not.toMatch(/width:\d+px/)
    expect(style).not.toContain('max-width')
  })

  // ── Precedencia: quién gana sobre qué ────────────────────────────────────────
  //
  // El equilibrio que hay que sostener, y que se rompió en las dos direcciones:
  //   · el TEMA manda sobre los TOKENS  (si no, el selector de paleta no hace nada)
  //   · el ARTEFACTO manda sobre las REGLAS (si no, se pierde su fondo)

  it('el tema gana en TOKENS y el artefacto gana en REGLAS', () => {
    const conFondo = ARTIFACT.replace(
      '@keyframes float { to { transform: translateY(-4px) } }',
      '@keyframes float { to { transform: translateY(-4px) } }\n  body { background: #123456 }',
    )
    const doc = htmlToDoc(conFondo)
    const otra = PALETTE_PRESETS.find((p) => p.name !== doc.theme.name) ?? PALETTE_PRESETS[0]
    const html = docToHtml({ ...doc, theme: { ...doc.theme, light: otra.light, dark: otra.dark } })

    // El token viene del tema elegido, no del que traía el artefacto.
    expect(html).toContain(`--color-primary: ${otra.light.primary}`)
    expect(html).not.toContain('--color-primary: #7c3aed')
    // Y su regla propia sobrevive.
    expect(html).toContain('background: #123456')
  })

  it('las reglas base del tema van en :where() y NUNCA con !important', () => {
    const css = themeToCss(htmlToDoc(ARTIFACT).theme)
    expect(css).toContain(':where(body)')
    expect(css).not.toContain('!important')
    // El bloque de variables NO va en :where(): tiene que poder ganarle al artefacto.
    expect(css).toMatch(/:root\s*\{/)
  })
})
