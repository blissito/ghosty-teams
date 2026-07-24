// Round-trip between the canonical Doc model and HTML.
// docToHtml() stamps data-id on every node and data-artboard-* on each frame,
// so htmlToDoc() can parse back losslessly. The emitted HTML (theme <style> +
// artboards) is what we persist in gc_artifacts.md and serve at artefacto.ghosty.studio.

import type { Artboard, Doc, Node, Theme } from './model'
import { DEFAULT_THEME, activeTokens, genId, walk } from './model'

const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'meta', 'link'])

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------------------
// Doc → HTML
// ---------------------------------------------------------------------------

function nodeToHtml(node: Node, indent: string): string {
  const attrs: string[] = [`data-id="${escAttr(node.id)}"`]
  if (node.cls) attrs.push(`class="${escAttr(node.cls)}"`)
  if (node.src != null) attrs.push(`src="${escAttr(node.src)}"`)
  if (node.href != null) attrs.push(`href="${escAttr(node.href)}"`)
  if (node.hidden) attrs.push('hidden')
  const open = `<${node.tag} ${attrs.join(' ')}>`

  if (VOID_TAGS.has(node.tag)) return `${indent}<${node.tag} ${attrs.join(' ')}>`

  const hasChildren = node.children.length > 0
  const hasText = node.text != null && node.text !== ''
  if (!hasChildren && !hasText) return `${indent}${open}</${node.tag}>`
  if (!hasChildren && hasText) return `${indent}${open}${esc(node.text!)}</${node.tag}>`

  const inner = node.children.map((c) => nodeToHtml(c, indent + '  ')).join('\n')
  const textPart = hasText ? `${indent}  ${esc(node.text!)}\n` : ''
  return `${indent}${open}\n${textPart}${inner}\n${indent}</${node.tag}>`
}

/**
 * Semantic Tailwind utilities implemented as plain CSS (bg-primary, text-foreground,
 * …). These are NOT default Tailwind classes and the host's compiled/JIT Tailwind
 * won't emit them, so we define them ourselves against the theme's CSS vars. This
 * is what makes colors actually render — in the live editor canvas (scoped) and in
 * the exported/preview HTML (global). Structural utilities (flex, px-4, rounded-full)
 * still come from Tailwind.
 */
export function semanticUtilityCss(scope = ''): string {
  const p = scope ? `${scope} ` : ''
  const colorPairs: [string, string][] = [
    ['background', 'background-color'],
    ['foreground', 'color'],
    ['primary', 'background-color'],
    ['secondary', 'background-color'],
    ['muted', 'background-color'],
    ['accent', 'background-color'],
  ]
  const bg = colorPairs
    .filter(([, prop]) => prop === 'background-color')
    .map(([name]) => `${p}.bg-${name}{background-color:var(--color-${name})}`)
    .join('\n')
  const text = ['foreground', 'muted-foreground', 'primary-foreground', 'secondary-foreground']
    .map((name) => `${p}.text-${name}{color:var(--color-${name})}`)
    .join('\n')
  const border = `${p}.border-border{border-color:var(--color-border)}`
  const radius = `${p}.rounded-\\[var\\(--radius\\)\\]{border-radius:var(--radius)}`
  return [bg, text, border, radius].join('\n')
}

/**
 * Theme CSS: :root vars (colors/radius/fonts) + font-family application + the
 * semantic utilities. `opts.scope` scopes the *applied* rules (fonts, base bg/text
 * color, semantic utilities) to the canvas so the editor chrome isn't restyled;
 * vars always sit at :root. Omit scope for standalone/preview HTML.
 */
export function themeToCss(theme: Theme, opts: { scope?: string } = {}): string {
  const scope = opts.scope ?? ''
  const base = scope || 'body'
  const headings = scope ? `${scope} h1,${scope} h2,${scope} h3,${scope} h4,${scope} h5,${scope} h6` : 'h1,h2,h3,h4,h5,h6'
  const vars = Object.entries(activeTokens(theme))
    .map(([k, v]) => `    --color-${k}: ${v};`)
    .join('\n')
  return `  :root {\n${vars}\n    --radius: ${theme.radius};\n    --font-heading: ${theme.fonts.heading};\n    --font-body: ${theme.fonts.body};\n    --font-mono: ${theme.fonts.mono};\n  }
  ${base} { font-family: var(--font-body), system-ui, sans-serif; background-color: var(--color-background); color: var(--color-foreground); }
  ${headings} { font-family: var(--font-heading), system-ui, sans-serif; }
${semanticUtilityCss(scope)}`
}

function artboardToHtml(ab: Artboard, opts: { centered?: boolean } = {}): string {
  const cls = ab.cls ? ` class="${escAttr(ab.cls)}"` : ''
  // In preview/publish, center each artboard (margin:auto) and cap at its design
  // width so it doesn't sit left-aligned inside a wider viewport ("chueco").
  const style = opts.centered
    ? `width:100%;max-width:${ab.w}px;min-height:${ab.h}px;margin:0 auto`
    : `width:${ab.w}px;min-height:${ab.h}px`
  const inner = ab.nodes.map((n) => nodeToHtml(n, '      ')).join('\n')
  return `    <section data-artboard-id="${escAttr(ab.id)}" data-artboard-name="${escAttr(
    ab.name,
  )}" data-x="${ab.x}" data-y="${ab.y}" data-w="${ab.w}" data-h="${ab.h}"${cls} style="${style}">\n${inner}\n    </section>`
}

/** Full standalone HTML document — used for persistence and ▶ preview / publish. */
export function docToHtml(doc: Doc): string {
  const multi = doc.artboards.length > 1
  const body = doc.artboards.map((ab) => artboardToHtml(ab, { centered: multi })).join('\n')
  return `<!doctype html>
<html data-theme="${doc.theme.mode}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script src="https://cdn.tailwindcss.com"></script>
<style>
${themeToCss(doc.theme)}
${arbitraryUtilityCss(doc)}
</style>
</head>
<body>
${body}
</body>
</html>`
}

// ---------------------------------------------------------------------------
// HTML → Doc  (browser: real DOM; server: pass a DOMParser-like via opts)
// ---------------------------------------------------------------------------

export interface ParseOpts {
  /** A DOMParser instance (jsdom on the server; global in the browser). */
  parser?: { parseFromString(s: string, t: string): Document }
}

function getParser(opts?: ParseOpts): { parseFromString(s: string, t: string): Document } {
  if (opts?.parser) return opts.parser
  if (typeof DOMParser !== 'undefined') return new DOMParser()
  throw new Error('htmlToDoc: no DOMParser available — pass opts.parser (jsdom) on the server')
}

function elToNode(el: Element): Node {
  const id = el.getAttribute('data-id') || genId('n')
  const tag = el.tagName.toLowerCase()
  const cls = el.getAttribute('class') || ''
  const src = el.getAttribute('src')
  const href = el.getAttribute('href')

  const children: Node[] = []
  let text: string | undefined
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3) {
      const t = (child.textContent || '').trim()
      if (t) text = text ? `${text} ${t}` : t
    } else if (child.nodeType === 1) {
      children.push(elToNode(child as Element))
    }
  }

  const node: Node = { id, tag, cls, children }
  if (text) node.text = text
  if (src != null) node.src = src
  if (href != null) node.href = href
  if (el.hasAttribute('hidden')) node.hidden = true
  return node
}

function elToArtboard(el: Element): Artboard {
  const num = (a: string, d: number) => {
    const v = el.getAttribute(a)
    const n = v == null ? NaN : Number(v)
    return Number.isFinite(n) ? n : d
  }
  const nodes = Array.from(el.children).map((c) => elToNode(c as Element))
  return {
    id: el.getAttribute('data-artboard-id') || genId('ab'),
    name: el.getAttribute('data-artboard-name') || 'Frame',
    x: num('data-x', 0),
    y: num('data-y', 0),
    w: num('data-w', 1440),
    h: num('data-h', 1024),
    cls: el.getAttribute('class') || undefined,
    nodes,
  }
}

function parseTheme(docEl: Document): Theme {
  const theme: Theme = {
    ...DEFAULT_THEME,
    light: { ...DEFAULT_THEME.light },
    dark: { ...DEFAULT_THEME.dark },
    fonts: { ...DEFAULT_THEME.fonts },
  }
  const html = docEl.documentElement
  const mode = html?.getAttribute('data-theme')
  if (mode === 'dark' || mode === 'light') theme.mode = mode
  const parsed: Record<string, string> = {}
  const styleText = docEl.querySelector('style')?.textContent || ''
  const rootMatch = styleText.match(/:root\s*{([^}]*)}/)
  if (rootMatch) {
    for (const decl of rootMatch[1].split(';')) {
      const m = decl.match(/--color-([\w-]+)\s*:\s*([^;]+)/)
      if (m) parsed[m[1].trim()] = m[2].trim()
      const r = decl.match(/--radius\s*:\s*([^;]+)/)
      if (r) theme.radius = r[1].trim()
      const fh = decl.match(/--font-heading\s*:\s*([^;]+)/)
      if (fh) theme.fonts.heading = fh[1].trim()
      const fb = decl.match(/--font-body\s*:\s*([^;]+)/)
      if (fb) theme.fonts.body = fb[1].trim()
      const fm = decl.match(/--font-mono\s*:\s*([^;]+)/)
      if (fm) theme.fonts.mono = fm[1].trim()
    }
  }
  // The emitted CSS carries only the active mode's palette; parse it back into that
  // mode (idempotent round-trip); the other mode keeps defaults.
  if (Object.keys(parsed).length > 0) {
    if (theme.mode === 'dark') theme.dark = parsed
    else theme.light = parsed
  }
  return theme
}

export function htmlToDoc(html: string, id = genId('doc'), opts?: ParseOpts): Doc {
  const parser = getParser(opts)
  const dom = parser.parseFromString(html, 'text/html')
  const abEls = Array.from(dom.querySelectorAll('[data-artboard-id]'))
  let artboards: Artboard[]
  if (abEls.length) {
    artboards = abEls.map(elToArtboard)
  } else {
    // Legacy / foreign HTML with no artboard wrappers → wrap the body as one desktop frame.
    const bodyKids = Array.from(dom.body?.children || [])
    artboards = [
      {
        id: genId('ab'),
        name: 'Desktop',
        x: 0,
        y: 0,
        w: 1440,
        h: 1024,
        nodes: bodyKids.map((c) => elToNode(c as Element)),
      },
    ]
  }
  return { id, artboards, theme: parseTheme(dom) }
}

// Arbitrary-value mini-JIT: the host's compiled Tailwind won't emit classes like
// w-[320px] or p-[13px], so we scan the doc for arbitrary-value utilities and emit
// their CSS ourselves — makes resize handles / fixed sizes real in the live canvas.
const ARBITRARY_PROP: Record<string, string | string[]> = {
  w: 'width', h: 'height', 'min-w': 'min-width', 'max-w': 'max-width', 'min-h': 'min-height', 'max-h': 'max-height',
  p: 'padding', px: ['padding-left', 'padding-right'], py: ['padding-top', 'padding-bottom'],
  pt: 'padding-top', pr: 'padding-right', pb: 'padding-bottom', pl: 'padding-left',
  m: 'margin', mx: ['margin-left', 'margin-right'], my: ['margin-top', 'margin-bottom'],
  mt: 'margin-top', mr: 'margin-right', mb: 'margin-bottom', ml: 'margin-left',
  gap: 'gap', top: 'top', left: 'left', right: 'right', bottom: 'bottom', rounded: 'border-radius',
  bg: 'background-color', border: 'border-color',
}

function cssEscapeClass(cls: string): string {
  return cls.replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\' + ch)
}

export function arbitraryUtilityCss(doc: Doc, scope = ''): string {
  const p = scope ? `${scope} ` : ''
  const seen = new Set<string>()
  const rules: string[] = []
  const consider = (cls: string) => {
    for (const raw of cls.split(/\s+/)) {
      if (!raw || seen.has(raw) || !raw.includes('[')) continue
      const m = raw.match(/^([a-z-]+)-\[(.+)\]$/)
      if (!m) continue
      const prefix = m[1]
      const value = m[2].replace(/_/g, ' ')
      const key = prefix === 'text' ? (value.startsWith('#') ? 'text-color' : 'text-size') : prefix
      const prop = key === 'text-color' ? 'color' : key === 'text-size' ? 'font-size' : ARBITRARY_PROP[key]
      if (!prop) continue
      seen.add(raw)
      const decls = Array.isArray(prop) ? prop.map((pp) => `${pp}:${value}`).join(';') : `${prop}:${value}`
      rules.push(`${p}.${cssEscapeClass(raw)}{${decls}}`)
    }
  }
  for (const ab of doc.artboards) walk(ab.nodes, (n) => consider(n.cls))
  return rules.join('\n')
}

/** Serialize a single node subtree to HTML (used for targeted refine payloads). */
export function nodeSubtreeToHtml(node: Node): string {
  return nodeToHtml(node, '').replace(/^\s+/gm, '')
}

/**
 * Parse a single element's HTML back into a Node (the return of a targeted
 * refine). If `keepId` is given it is forced onto the root so addressing stays
 * stable even if the model dropped/changed the data-id. Returns null if the
 * fragment has no element (e.g. mid-stream partial that isn't yet parseable).
 */
export function htmlToNode(html: string, keepId?: string, opts?: ParseOpts): Node | null {
  const parser = getParser(opts)
  const dom = parser.parseFromString(`<body>${html}</body>`, 'text/html')
  const el = dom.body?.firstElementChild
  if (!el) return null
  const node = elToNode(el)
  if (keepId) node.id = keepId
  return node
}
