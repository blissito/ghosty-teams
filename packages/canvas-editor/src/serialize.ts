// Round-trip between the canonical Doc model and HTML.
// docToHtml() stamps data-id on every node and data-artboard-* on each frame,
// so htmlToDoc() can parse back losslessly. The emitted HTML (theme <style> +
// artboards) is what we persist in gc_artifacts.md and serve at artefacto.ghosty.studio.

import type { Artboard, Doc, DocShell, Node, ShellAsset, Theme } from './model'
import { DEFAULT_THEME, activeTokens, genId, googleFontsHref, walk } from './model'

const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'meta', 'link'])
/**
 * Elementos cuyo contenido es texto CRUDO, no markup. Escaparlo los rompe: un
 * selector `.a > .b` volvía como `.a &gt; .b` y el CSS del usuario se degradaba
 * un poco más en cada ida y vuelta por el editor.
 */
const RAW_TEXT_TAGS = new Set(['style', 'script'])
/** Los que el `Node` ya tipa: el resto viaja en `node.attrs`. */
const MODELED_ATTRS = new Set(['data-id', 'class', 'src', 'href', 'style', 'hidden'])

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
  if (node.style != null && node.style !== '') attrs.push(`style="${escAttr(node.style)}"`)
  for (const [k, v] of Object.entries(node.attrs ?? {})) {
    attrs.push(v === '' ? k : `${k}="${escAttr(v)}"`)
  }
  if (node.hidden) attrs.push('hidden')
  const open = `<${node.tag} ${attrs.join(' ')}>`

  if (VOID_TAGS.has(node.tag)) return `${indent}<${node.tag} ${attrs.join(' ')}>`

  const hasChildren = node.children.length > 0
  const hasText = node.text != null && node.text !== ''
  const escText = RAW_TEXT_TAGS.has(node.tag) ? (s: string) => s : esc
  if (!hasChildren && !hasText) return `${indent}${open}</${node.tag}>`
  if (!hasChildren && hasText) return `${indent}${open}${escText(node.text!)}</${node.tag}>`

  const inner = node.children.map((c) => nodeToHtml(c, indent + '  ')).join('\n')
  const textPart = hasText ? `${indent}  ${escText(node.text!)}\n` : ''
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
  const text = ['foreground', 'muted-foreground', 'primary-foreground', 'secondary-foreground', 'accent', 'primary']
    .map((name) => `${p}.text-${name}{color:var(--color-${name})}`)
    .join('\n')
  const border = ['border', 'primary', 'secondary', 'muted', 'accent', 'foreground']
    .map((name) => `${p}.border-${name}{border-color:var(--color-${name === 'border' ? 'border' : name})}`)
    .join('\n')
  const radius = `${p}.rounded-\\[var\\(--radius\\)\\]{border-radius:var(--radius)}`
  // Grid column utilities — the host's compiled Tailwind may not emit these, so
  // define them (like the color tokens) or they'd silently no-op in the canvas.
  const gridCols = [1, 2, 3, 4, 5, 6]
    .map((n) => `${p}.grid-cols-${n}{grid-template-columns:repeat(${n},minmax(0,1fr))}`)
    .join('\n')
  const gridFlow = `${p}.grid-flow-col{grid-auto-flow:column}`
  return [bg, text, border, radius, gridCols, gridFlow].join('\n')
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
  // Los tokens viven en el SCOPE cuando hay uno. Antes salían siempre en `:root` global:
  // dentro del editor de Teams eso clobbereaba los tokens Tailwind v4 de la propia UI, y
  // por eso el host los suprimía (`suppressThemeCss`) — con el efecto de que el selector
  // de paleta no pintaba NADA sobre el artefacto. Scoped = sin fuga y con tema aplicable.
  const varScope = scope || ':root'
  // ⚠️ Las reglas BASE van en `:where()`, que tiene especificidad CERO, para que
  // cualquier regla propia del artefacto les gane pase lo que pase con el orden de la
  // cascada. Es el sustituto legítimo de un `!important` invertido — y `!important` está
  // prohibido en este ecosistema. Sin esto, el `body { background-color: … }` del tema
  // empataba en especificidad con el `body{background:…}` del artefacto y ganaba el
  // último en salir, que cambia entre la superficie de edición y el HTML publicado.
  //
  // NO se envuelven ni el bloque de VARIABLES ni `semanticUtilityCss`: los tokens tienen
  // que seguir con especificidad normal, porque son justo lo que el selector de paleta
  // usa para mandar sobre el artefacto (ver stripThemeTokens y theme-scope.test.ts).
  return `  ${varScope} {\n${vars}\n    --radius: ${theme.radius};\n    --font-heading: ${theme.fonts.heading};\n    --font-body: ${theme.fonts.body};\n    --font-mono: ${theme.fonts.mono};\n  }
  :where(${base}) { font-family: var(--font-body), system-ui, sans-serif; background-color: var(--color-background); color: var(--color-foreground); }
  :where(${headings}) { font-family: var(--font-heading), system-ui, sans-serif; }
${semanticUtilityCss(scope)}`
}

function artboardToHtml(ab: Artboard, opts: { centered?: boolean } = {}): string {
  const cls = ab.cls ? ` class="${escAttr(ab.cls)}"` : ''
  // In preview/publish, center each artboard (margin:auto) and cap at its design
  // width so it doesn't sit left-aligned inside a wider viewport ("chueco").
  // SIEMPRE responsivo: con `width:${ab.w}px` fijo (el caso de un solo artboard) el HTML
  // publicado medía 1440px pasara lo que pasara → scroll horizontal en el panel y en móvil
  // (regresión vista al guardar desde el editor, 2026-07-24). `width:100%` + `max-width`
  // conserva el ancho de diseño sin desbordar.
  // Un solo frame (el caso de un artefacto) → FULL-BLEED: `width:100%` sin tope. Con
  // `width:${ab.w}px` fijo salía scroll horizontal en el panel, y con `max-width` quedaba
  // una franja blanca en pantallas anchas (reportado 2026-07-24). Con varios frames sí se
  // centra cada uno a su ancho de diseño para poder distinguirlos.
  const style = opts.centered
    ? `width:100%;max-width:${ab.w}px;min-height:${ab.h}px;margin:0 auto`
    : `width:100%;min-height:${ab.h}px`
  const inner = ab.nodes.map((n) => nodeToHtml(n, '      ')).join('\n')
  return `    <section data-artboard-id="${escAttr(ab.id)}" data-artboard-name="${escAttr(
    ab.name,
  )}" data-x="${ab.x}" data-y="${ab.y}" data-w="${ab.w}" data-h="${ab.h}"${cls} style="${style}">\n${inner}\n    </section>`
}

/** Full standalone HTML document — used for persistence and ▶ preview / publish. */
/**
 * Marca los elementos que emite ESTE archivo. `parseShell` los salta, y sin eso cada ida
 * y vuelta acumularía otra copia del CSS del tema dentro de `doc.shell`: el artefacto
 * crecería en cada guardado y al segundo viaje el selector de paleta dejaría de mandar.
 * Es el invariante más caro de esta pieza — lo cubre el test anti-crecimiento.
 */
export const CE_MARK = 'data-ce'

/**
 * Quita del CSS las DECLARACIONES de token del tema, dejando el resto intacto.
 *
 * ⚠️ Existe por un bug concreto (2026-07-24): un artefacto trae su propia paleta en
 * `:root` para ser autocontenido en su URL pública. Al reescribir ese `:root` al scope
 * del editor quedaba con la MISMA especificidad que la paleta del editor y, al ir
 * después en la cascada, GANABA → el selector de paleta no hacía nada. `doc.theme` ya
 * absorbió esos tokens al parsear, así que aquí sobran.
 *
 * Sólo las declaraciones: `@keyframes`, reglas propias y cualquier otra cosa se conserva.
 */
export function stripThemeTokens(css: string): string {
  // ⚠️ El separador de delante es parte del arreglo. El regex heredado del host anclaba
  // en `^` (inicio de línea), así que sólo limpiaba CSS formateado: un `:root{--color-x:…}`
  // en UNA sola línea —lo que emite cualquier minificador— pasaba entero y volvía a
  // ganarle al selector de paleta. Ahora vale también tras `{` o `;`.
  //
  // Y el separador va en LOOKBEHIND, no capturado: consumiéndolo, el `;` que separa dos
  // tokens seguidos se comía con el primero y el segundo se quedaba sin delimitador a la
  // izquierda — `{--a:1;--b:2}` perdía `--a` en el primer viaje y `--b` en el SEGUNDO. El
  // test anti-crecimiento lo cazó: dos round-trips daban HTML distinto.
  return css.replace(
    /(?<=^|[{;])\s*--(?:color-[\w-]+|radius|font-(?:heading|body|mono))\s*:[^;}]*;?/gim,
    '',
  )
}

/**
 * El CSS propio del artefacto, listo para la SUPERFICIE DE EDICIÓN: reescribe los
 * selectores de documento (`html`, `body`, `:root`) al scope del lienzo, porque dentro
 * del editor el elemento que hace de `<body>` es el `.ce-artboard`.
 *
 * Vivía copiado en `ArtifactPanel.tsx` con un regex sobre el HTML crudo; ahora se sirve
 * del `doc.shell`, que ya viene parseado y sin tokens.
 */
export function shellStyleCss(
  shell: DocShell | undefined,
  opts: { scope?: string } = {},
): string {
  const scope = opts.scope ?? '.ce-artboard'
  const css = (shell?.assets ?? [])
    .filter((a) => a.kind === 'style')
    .map((a) => a.text ?? '')
    .join('\n')
  return css
    .replace(/(^|[\s,{}])(html|body)\b/gi, `$1${scope}`)
    .replace(/:root\b/gi, scope)
}

export interface DocToHtmlOpts {
  /** HTML extra al final del `<head>`. Sustituye al `.replace("</head>", …)` del host. */
  headExtra?: string
  /** Omitir los `<script>` del shell (preview sandboxeado, copiar al portapapeles…). */
  omitScripts?: boolean
}

function assetToHtml(a: ShellAsset): string {
  const attrs = Object.entries(a.attrs ?? {})
    .map(([k, v]) => (v === '' ? k : `${k}="${escAttr(v)}"`))
    .join(' ')
  const open = attrs ? `<${a.kind} ${attrs}>` : `<${a.kind}>`
  // link y meta son void; el resto lleva su texto CRUDO (no se escapa: es CSS o JS).
  if (a.kind === 'link' || a.kind === 'meta') return open
  return `${open}${a.text ?? ''}</${a.kind}>`
}

function shellHtml(shell: DocShell | undefined, slot: ShellAsset['slot'], opts: DocToHtmlOpts): string {
  const assets = (shell?.assets ?? []).filter(
    (a) => a.slot === slot && !(opts.omitScripts && a.kind === 'script'),
  )
  return assets.length ? '\n' + assets.map(assetToHtml).join('\n') : ''
}

function attrsHtml(attrs: Record<string, string> | undefined): string {
  const e = Object.entries(attrs ?? {})
  return e.length ? ' ' + e.map(([k, v]) => (v === '' ? k : `${k}="${escAttr(v)}"`)).join(' ') : ''
}

/**
 * HTML completo y autónomo — persistencia, preview y publicación.
 *
 * ⚠️ El ORDEN del `<head>` es cascada: el CSS del TEMA va primero y el del ARTEFACTO
 * después, para que las reglas propias del artefacto ganen. Los tokens del tema no se
 * pierden por eso: viven en un bloque de variables aparte, con especificidad normal,
 * mientras que las reglas base del tema van en `:where()` (especificidad cero).
 */
export function docToHtml(doc: Doc, opts: DocToHtmlOpts = {}): string {
  const multi = doc.artboards.length > 1
  const body = doc.artboards.map((ab) => artboardToHtml(ab, { centered: multi })).join('\n')
  const shell = doc.shell
  // Con UN solo artboard, su `cls` es la del <body> (parseShell la copió ahí) y es la que
  // el usuario pudo editar: manda ella. Con varios, el body no representa a ninguno.
  const bodyCls = doc.artboards.length === 1 ? (doc.artboards[0].cls ?? shell?.bodyCls) : shell?.bodyCls
  return `<!doctype html>
<html data-theme="${doc.theme.mode}"${attrsHtml(shell?.htmlAttrs)}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script ${CE_MARK}="tw" src="https://cdn.tailwindcss.com"></script>
<link ${CE_MARK}="fonts" rel="stylesheet" href="${googleFontsHref([doc.theme.fonts.heading, doc.theme.fonts.body])}">
<style ${CE_MARK}="theme">
${themeToCss(doc.theme)}
${arbitraryUtilityCss(doc)}
</style>${shellHtml(shell, 'head', opts)}${opts.headExtra ? '\n' + opts.headExtra : ''}
</head>
<body${bodyCls ? ` class="${escAttr(bodyCls)}"` : ''}${attrsHtml(shell?.bodyAttrs)}>
${body}${shellHtml(shell, 'body-end', opts)}
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
  // <style>/<script>: el contenido se toma VERBATIM. El aplanado de abajo une
  // los text-nodes con espacios y hace trim — sobre una hoja de estilos eso
  // colapsa los saltos de línea y la deja irreconocible.
  if (RAW_TEXT_TAGS.has(tag)) {
    // Sin recorrer hijos, y sin salir de la función: abajo se recogen
    // src/style/attrs/hidden, que un <script src> o un <style media> necesitan.
    text = el.textContent || undefined
  } else {
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) {
        const t = (child.textContent || '').trim()
        if (t) text = text ? `${text} ${t}` : t
      } else if (child.nodeType === 1) {
        children.push(elToNode(child as Element))
      }
    }
  }

  const node: Node = { id, tag, cls, children }
  if (text) node.text = text
  if (src != null) node.src = src
  if (href != null) node.href = href
  const styleAttr = el.getAttribute('style')
  if (styleAttr) node.style = styleAttr
  // Todo lo que el modelo NO tipa se guarda tal cual: sin esto un <svg> vuelve
  // sin `viewBox` y sus <path> sin `d`, o sea un cuadro vacío. Ver Node.attrs.
  const rest: Record<string, string> = {}
  for (const a of Array.from(el.attributes)) {
    if (MODELED_ATTRS.has(a.name)) continue
    rest[a.name] = a.value
  }
  if (Object.keys(rest).length) node.attrs = rest
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
  // TODOS los <style>, no sólo el primero: un artefacto real declara sus tokens en
  // cualquiera de ellos (el que destapó esto tenía CINCO y el `:root` no estaba en el
  // primero).
  //
  // ⚠️ Aquí NO se filtra por CE_MARK, al revés que en `parseShell`. El `<style>` del
  // editor es la fuente CANÓNICA del tema —es la paleta que el usuario eligió— y va
  // primero en el documento, así que el regex de `:root` lo encuentra antes que el del
  // artefacto y gana. Filtrarlo dejaba el round-trip del editor consigo mismo sin tema.
  const styleText = Array.from(docEl.querySelectorAll('style'))
    .map((el) => el.textContent || '')
    .join('\n')
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

const SHELL_TAGS: Record<string, ShellAsset['kind']> = {
  style: 'style',
  script: 'script',
  link: 'link',
  meta: 'meta',
  title: 'title',
}
/** Los que `docToHtml` re-emite siempre: preservarlos duplicaría el head en cada viaje. */
const SHELL_SKIP_META = new Set(['charset', 'viewport'])

function elToAsset(el: Element, slot: ShellAsset['slot']): ShellAsset | null {
  const kind = SHELL_TAGS[el.tagName.toLowerCase()]
  if (!kind) return null
  // Lo que emitió el editor no se preserva: se regenera solo (ver CE_MARK).
  if (el.hasAttribute(CE_MARK)) return null
  if (kind === 'meta') {
    const name = el.getAttribute('name') || (el.hasAttribute('charset') ? 'charset' : '')
    if (SHELL_SKIP_META.has(name)) return null
  }
  const attrs: Record<string, string> = {}
  for (const a of Array.from(el.attributes)) attrs[a.name] = a.value
  const asset: ShellAsset = { kind, slot }
  if (Object.keys(attrs).length) asset.attrs = attrs
  // style/script/title llevan texto CRUDO; el resto son elementos vacíos.
  if (kind === 'style' || kind === 'script' || kind === 'title') {
    const raw = el.textContent || ''
    // Los tokens del artefacto ya viven en `doc.theme`; dejarlos aquí los duplicaría y
    // le ganarían al selector de paleta (ver stripThemeTokens).
    asset.text = kind === 'style' ? stripThemeTokens(raw) : raw
  }
  return asset
}

/**
 * Recoge del DOM todo lo que no es árbol de nodos: atributos de `<html>` y `<body>`, y
 * los `<style>`/`<script>`/`<link>` del `<head>` y del final del `<body>`.
 */
function parseShell(dom: Document): DocShell | undefined {
  const shell: DocShell = {}
  const assets: ShellAsset[] = []

  for (const el of Array.from(dom.head?.children || [])) {
    const a = elToAsset(el as Element, 'head')
    if (a) assets.push(a)
  }
  // Hijos directos del body: van al SHELL, no al árbol. Antes entraban como nodos y el
  // host los podaba después (ArtifactPanel), así que su CSS sólo sobrevivía por un regex.
  for (const el of Array.from(dom.body?.children || [])) {
    const a = elToAsset(el as Element, 'body-end')
    if (a) assets.push(a)
  }
  if (assets.length) shell.assets = assets

  const htmlEl = dom.documentElement
  if (htmlEl) {
    const htmlAttrs: Record<string, string> = {}
    for (const a of Array.from(htmlEl.attributes)) {
      if (a.name !== 'data-theme') htmlAttrs[a.name] = a.value
    }
    if (Object.keys(htmlAttrs).length) shell.htmlAttrs = htmlAttrs
  }
  const bodyEl = dom.body
  if (bodyEl) {
    const cls = bodyEl.getAttribute('class')
    if (cls) shell.bodyCls = cls
    const bodyAttrs: Record<string, string> = {}
    for (const a of Array.from(bodyEl.attributes)) {
      if (a.name !== 'class') bodyAttrs[a.name] = a.value
    }
    if (Object.keys(bodyAttrs).length) shell.bodyAttrs = bodyAttrs
  }
  return Object.keys(shell).length ? shell : undefined
}

export function htmlToDoc(html: string, id = genId('doc'), opts?: ParseOpts): Doc {
  const parser = getParser(opts)
  const dom = parser.parseFromString(html, 'text/html')
  const shell = parseShell(dom)
  const abEls = Array.from(dom.querySelectorAll('[data-artboard-id]'))
  let artboards: Artboard[]
  if (abEls.length) {
    artboards = abEls.map(elToArtboard)
  } else {
    // Legacy / foreign HTML with no artboard wrappers → wrap the body as one desktop frame.
    const bodyKids = Array.from(dom.body?.children || []).filter(
      (c) => !SHELL_TAGS[c.tagName.toLowerCase()],
    )
    artboards = [
      {
        id: genId('ab'),
        name: 'Desktop',
        x: 0,
        y: 0,
        w: 1440,
        h: 1024,
        // La clase del <body> se COPIA al artboard porque en el editor la superficie que
        // hace de body es el `.ce-artboard`: sin esto, `min-h-screen` y compañía se veían
        // distinto editando que publicado. Al exportar manda ésta (ver DocShell).
        cls: shell?.bodyCls,
        nodes: bodyKids.map((c) => elToNode(c as Element)),
      },
    ]
  }
  const doc: Doc = { id, artboards, theme: parseTheme(dom) }
  if (shell) doc.shell = shell
  return doc
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
  // Faltaban y eran no-op: una clase sin regla se ve distinta aquí que publicada.
  aspect: 'aspect-ratio', leading: 'line-height', tracking: 'letter-spacing', z: 'z-index',
  'grid-cols': 'grid-template-columns', 'grid-rows': 'grid-template-rows',
  shadow: 'box-shadow', opacity: 'opacity', 'border-w': 'border-width', basis: 'flex-basis',
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
      const rawValue = m[2]
      const isUrl = /^url\(/i.test(rawValue)
      // El guion bajo es el escape de Tailwind para el espacio… salvo dentro de
      // una url(): ahí un `_` es parte del nombre del archivo y sustituirlo
      // rompía la imagen — pero SÓLO en el lienzo, nunca en el sitio publicado.
      const value = isUrl ? rawValue : rawValue.replace(/_/g, ' ')
      // `text-[…]` es color o tamaño según el valor. Antes solo `#hex` contaba como color:
      // `text-[var(--color-foreground)]` (lo que emiten los artefactos con tokens) caía en
      // font-size → el texto perdía su color Y heredaba un font-size inválido.
      const isColor = /^(#|rgb|hsl|oklch|color\()/i.test(value) || /^var\(\s*--color-/i.test(value)
      const key =
        prefix === 'text'
          ? isColor ? 'text-color' : 'text-size'
          : // `bg-[url(…)]` es una IMAGEN, no un color. Se emitía
            // `background-color:url(…)` — declaración inválida que el navegador
            // descarta, así que la foto de fondo desaparecía del lienzo y sólo
            // se veía en el sitio publicado.
            prefix === 'bg' && isUrl ? 'bg-image' : prefix
      const prop =
        key === 'text-color' ? 'color'
        : key === 'text-size' ? 'font-size'
        : key === 'bg-image' ? 'background-image'
        : ARBITRARY_PROP[key]
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
export function htmlToNode(
  html: string,
  keepId?: string,
  opts?: ParseOpts & {
    /**
     * Qué hacer si el fragmento trae VARIOS elementos de nivel superior.
     * Por defecto se toma el primero, que es lo correcto para un refine: ahí el
     * modelo debe devolver UN elemento y envolver su respuesta cambiaría el tag
     * del nodo (un `<section>` volvería como `<div>`).
     *
     * `wrapMultiple` es para cargar contenido persistido, donde perder los
     * hermanos es pérdida de datos: una sección guardada como dos `<section>`
     * hermanas, o como `<style>…</style><section>…</section>`, entraba al editor
     * mutilada y se volvía a publicar así.
     */
    wrapMultiple?: boolean
  },
): Node | null {
  const parser = getParser(opts)
  const dom = parser.parseFromString(`<body>${html}</body>`, 'text/html')
  const els = Array.from(dom.body?.children ?? [])
  if (!els.length) return null
  const node =
    els.length === 1 || !opts?.wrapMultiple
      ? elToNode(els[0])
      : { id: genId('n'), tag: 'div', cls: '', children: els.map((e) => elToNode(e)) }
  if (keepId) node.id = keepId
  return node
}
