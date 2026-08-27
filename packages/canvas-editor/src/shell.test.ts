// @vitest-environment jsdom
//
// El "shell" del documento: todo lo que no es árbol de nodos ni tema — el CSS propio del
// artefacto, sus <script>, la clase del <body>.
//
// Estos tests existen por un bug de producción: en la demo del 2026-08-27 un cliente
// editó una landing y PERDIÓ EL FONDO. El fondo era un `<div class="grid-paper">` cuyo
// CSS vivía en uno de los CINCO bloques <style> del artefacto, y el round-trip del canvas
// sólo miraba el primero, no leía el <body class> y emitía `<body>` desnudo.
import { describe, expect, it } from 'vitest'
import { docToHtml, htmlToDoc, stripThemeTokens } from './serialize'

/** Reducción fiel del artefacto real (gc_artifacts id 34 del tenant de CoreGrid). */
const LANDING = `<!doctype html>
<html>
<head>
<title>CoreGrid</title>
<meta name="description" content="CRM técnico">
<link rel="stylesheet" href="https://fonts.example/x.css">
<style>:root{--color-border:#2a2a2a;--color-primary:#7c3aed}</style>
<style>@keyframes pulso{from{opacity:.4}to{opacity:1}}</style>
<style>.grid-paper{ position:fixed; inset:0; pointer-events:none; z-index:0;
  background-image: linear-gradient(var(--color-border) 1px, transparent 1px); }</style>
</head>
<body class="min-h-screen bg-slate-950">
<div class="grid-paper"></div>
<header class="sticky top-0"><h1 class="text-2xl">CoreGrid</h1></header>
<script>const app = { n: 1 < 2 && true }</script>
</body>
</html>`

describe('shell del documento', () => {
  it('captura TODOS los bloques <style>, no sólo el primero', () => {
    const doc = htmlToDoc(LANDING)
    const styles = (doc.shell?.assets ?? []).filter((a) => a.kind === 'style')
    expect(styles).toHaveLength(3)
    expect(styles.map((s) => s.text).join('\n')).toContain('grid-paper')
  })

  it('EL BUG DEL CLIENTE: el fondo sobrevive el round-trip', () => {
    const out = docToHtml(htmlToDoc(LANDING))
    expect(out).toContain('.grid-paper{')
    expect(out).toContain('position:fixed')
    expect(out).toContain('linear-gradient(var(--color-border) 1px')
    // `data-id` va primero (lo estampa nodeToHtml), por eso no se busca el atributo pegado.
    expect(out).toMatch(/<div [^>]*class="grid-paper"/)
    // La clase del <body>, que es lo que daba el alto y el color de fondo base.
    expect(out).toMatch(/<body class="[^"]*min-h-screen/)
    expect(out).toMatch(/<body class="[^"]*bg-slate-950/)
  })

  it('preserva <script> verbatim, sin escapar', () => {
    const out = docToHtml(htmlToDoc(LANDING))
    // Si se escapara, `1 < 2 && true` saldría como `1 &lt; 2 &amp;&amp; true`.
    expect(out).toContain('const app = { n: 1 < 2 && true }')
  })

  it('preserva <link>, <title> y <meta> propios', () => {
    const out = docToHtml(htmlToDoc(LANDING))
    expect(out).toContain('<title>CoreGrid</title>')
    expect(out).toContain('content="CRM técnico"')
    expect(out).toContain('https://fonts.example/x.css')
  })

  it('los <style>/<script> del body van al shell, NO al árbol de nodos', () => {
    const doc = htmlToDoc(LANDING)
    const tags = doc.artboards[0].nodes.map((n) => n.tag)
    expect(tags).not.toContain('style')
    expect(tags).not.toContain('script')
    expect(tags).toContain('div')
  })

  it('ANTI-CRECIMIENTO: dos viajes no acumulan estilos ni cambian el HTML', () => {
    const uno = docToHtml(htmlToDoc(LANDING))
    const dos = docToHtml(htmlToDoc(uno))
    expect(dos).toBe(uno)
    const cuenta = (h: string) => (h.match(/<style/g) || []).length
    expect(cuenta(dos)).toBe(cuenta(uno))
  })

  it('stripThemeTokens quita tokens y NADA más', () => {
    const css = stripThemeTokens(
      ':root{--color-primary:#7c3aed;}\n@keyframes p{from{opacity:0}}\n.grid-paper{inset:0}',
    )
    expect(css).not.toContain('--color-primary')
    expect(css).toContain('@keyframes')
    expect(css).toContain('.grid-paper{inset:0}')
  })
})
