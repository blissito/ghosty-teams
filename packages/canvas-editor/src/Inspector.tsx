// Right panel: a structured property inspector modeled on efecto — Node (Tag,
// Content), Layout (Display), Typography (Size/Leading/Weight/Tracking/Align),
// Size & Spacing (W/H Hug/Fill/Fixed, Padding, Margin, Overflow), Colors, Radius,
// plus a collapsible </> code panel for the raw className, and a streaming Refine
// box. Los controles leen el CSS efectivo del DOM y escriben declaraciones inline
// (ver cssProps.ts): así ganan sobre las clases y sobre el <style> del artefacto.

import { useLayoutEffect, useRef, useState } from 'react'
import { FONT_OPTIONS, PALETTE_PRESETS, activeTokens, findNode, type Doc, type Node } from './model'
import { backgroundUrl, clearBackground, makeFullBleed, makeHeroBackground, parentOf, refineContext, setBackground } from './imageOps'
import { htmlToNode, nodeSubtreeToHtml } from './serialize'
import { addClass, autocomplete, classList, removeClass, toggleClass } from './tailwindClasses'
import {
  COLOR_TOKENS,
  CSS_OPTIONS,
  displayDecls,
  displayOf,
  sizingOf,
  sizingValue,
  toHex,
  nodeEl,
  optionForValue,
  type DisplayMode,
  type Opt,
  type Sizing,
} from './cssProps'
import type { EditorState, EditorStore } from './store'
import type { AgentAction, ImageProvider, ModelOption, RefineProvider } from './refine'

const TEXT_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'a', 'button', 'li', 'label'])
const TAG_OPTIONS = ['div', 'section', 'h1', 'h2', 'h3', 'h4', 'p', 'span', 'a', 'button', 'ul', 'li', 'img']

export function Inspector({
  store,
  state,
  refineProvider,
  imageProvider,
  onAgentAction,
}: {
  store: EditorStore
  state: EditorState
  refineProvider?: RefineProvider
  imageProvider?: ImageProvider
  onAgentAction?: AgentAction
}) {
  const node = state.selection ? findNode(state.doc, state.selection) : null
  const multi = state.selectionSet.length
  return (
    <div style={styles.panel}>
      {multi > 1 && (
        <div style={{ padding: '10px 12px', borderBottom: '1px solid #1a1d24' }}>
          <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 6 }}>{multi} elementos seleccionados</div>
          <button style={styles.robot} onClick={() => store.groupSelection()}>
            ⧉ Agrupar en autolayout (⌘G)
          </button>
        </div>
      )}
      {!node ? (
        <div style={styles.empty}>Toca una capa para editarla, o el fondo para navegar.</div>
      ) : (
        <div style={styles.scroll}>
          {onAgentAction && (
            <div style={{ padding: '8px 12px', borderBottom: '1px solid #1a1d24' }}>
              <button style={styles.robot} onClick={() => onAgentAction({ nodeId: node.id, nodeHtml: nodeSubtreeToHtml(node) })}>
                🤖 Preguntar al agente sobre este nodo
              </button>
            </div>
          )}
          <NodePanel store={store} node={node} />
          <LayoutPanel store={store} node={node} dep={state.doc} />
          <ChildLayoutPanel store={store} node={node} dep={state.doc} />
          {(TEXT_TAGS.has(node.tag) || node.text != null) && <TypographyPanel store={store} node={node} dep={state.doc} />}
          <SizeSpacingPanel store={store} node={node} dep={state.doc} />
          <ColorsPanel store={store} node={node} dep={state.doc} />
          <EffectsPanel store={store} node={node} dep={state.doc} />
          {/* Imagen Y fondo: el panel vive con CUALQUIER nodo seleccionado. Antes
              sólo aparecía en <img>, así que un hero cuya foto es el
              background-image de un <div> no se podía cambiar ni quitar. */}
          {/* El key REMONTA el panel al cambiar de nodo (resetea modo, URL, error).
              Debe ser único entre hermanos: compartirlo con RefinePanel hacía que
              React duplicara la sección. */}
          <ImagePanel key={`img-${node.id}`} store={store} node={node} doc={state.doc} imageProvider={imageProvider} />
          <ClassChips store={store} node={node} />
          <InlineStylePanel store={store} node={node} />
          {refineProvider && <RefinePanel key={`refine-${node.id}`} store={store} node={node} doc={state.doc} refineProvider={refineProvider} />}
        </div>
      )}
      {/* Con un nodo seleccionado el Tema estorba: nace CONTRAÍDO (y se resetea al
          cambiar de contexto gracias al key). Sin selección queda abierto. */}
      <ThemePanel key={node ? 'sel' : 'nosel'} store={store} state={state} defaultOpen={!node} />
    </div>
  )
}

// --- Class chips + Tailwind IntelliSense autocomplete (+ collapsible raw editor) ---
function ClassChips({ store, node }: { store: EditorStore; node: Node }) {
  const [q, setQ] = useState('')
  const [raw, setRaw] = useState(false)
  const suggestions = autocomplete(q)
  const chips = classList(node.cls)
  return (
    <Section
      title="Clases"
      action={
        <button title={raw ? 'Editor visual' : 'Editar como texto'} style={styles.iconBtn} onClick={() => setRaw(!raw)}>
          {raw ? IconChips : IconCode}
        </button>
      }
    >
      {raw ? (
        <textarea
          style={{ ...styles.input, fontFamily: 'monospace', minHeight: 72, resize: 'vertical' }}
          value={node.cls}
          spellCheck={false}
          onChange={(e) => store.setNodeClasses(node.id, e.target.value)}
        />
      ) : (
        <>
          <div style={styles.chips}>
            {chips.map((c) => (
              <button key={c} style={styles.chip} title="Quitar" onClick={() => store.setNodeClasses(node.id, removeClass(node.cls, c))}>
                {c} <span style={{ opacity: 0.6 }}>✕</span>
              </button>
            ))}
          </div>
          <div style={{ position: 'relative' }}>
            <input
              style={{ ...styles.input, fontFamily: 'monospace' }}
              placeholder="añadir clase…"
              value={q}
              spellCheck={false}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && q.trim()) {
                  store.setNodeClasses(node.id, toggleClass(node.cls, q.trim()))
                  setQ('')
                }
              }}
            />
            {suggestions.length > 0 && (
              <div style={styles.menu}>
                {suggestions.map((s) => (
                  <button key={s} style={{ ...styles.menuItem, fontFamily: 'monospace' }} onClick={() => { store.setNodeClasses(node.id, addClass(node.cls, s)); setQ('') }}>
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </Section>
  )
}

/**
 * `style="…"` inline del nodo, como chips que se pueden QUITAR uno por uno (y
 * editar en crudo). Es la tercera estrategia con la que el agente estiliza —
 * junto a las clases Tailwind y a las reglas del <style> del artefacto (esas se
 * desactivan quitando la clase que las dispara, ej. `heading`). Nada queda fuera
 * del alcance del editor.
 */
function InlineStylePanel({ store, node }: { store: EditorStore; node: Node }) {
  const [raw, setRaw] = useState(false)
  const decls = (node.style ?? '')
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
  if (!decls.length && !raw) return null
  return (
    <Section
      title="Estilo inline"
      action={
        <button title={raw ? 'Chips' : 'Editar como texto'} style={styles.iconBtn} onClick={() => setRaw(!raw)}>
          {raw ? IconChips : IconCode}
        </button>
      }
    >
      {raw ? (
        <textarea
          style={{ ...styles.input, fontFamily: 'monospace', minHeight: 60, resize: 'vertical' }}
          value={node.style ?? ''}
          spellCheck={false}
          onChange={(e) => store.updateNode(node.id, { style: e.target.value })}
        />
      ) : (
        <div style={styles.chips}>
          {decls.map((d) => {
            const prop = d.slice(0, d.indexOf(':')).trim()
            return (
              <button key={d} style={styles.chip} title="Quitar" onClick={() => store.setNodeStyleProp(node.id, prop, null)}>
                {d} <span style={{ opacity: 0.6 }}>✕</span>
              </button>
            )
          })}
        </div>
      )}
    </Section>
  )
}

// two-state icons: code (raw closed) vs chips/tags (visual)
const IconCode = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
  </svg>
)
const IconChips = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20.59 13.41 13.42 20.6a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82Z" /><circle cx="7" cy="7" r="1.2" fill="currentColor" />
  </svg>
)

// --- Node: tag + content ---
function NodePanel({ store, node }: { store: EditorStore; node: Node }) {
  return (
    <Section title="Nodo">
      <Row label="Tag">
        <select style={styles.select} value={node.tag} onChange={(e) => store.updateNode(node.id, { tag: e.target.value })}>
          {TAG_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {`<${t}>`}
            </option>
          ))}
        </select>
      </Row>
      {node.text != null && (
        <Row label="Texto">
          <textarea style={{ ...styles.input, minHeight: 40, resize: 'vertical' }} value={node.text} onChange={(e) => store.setNodeText(node.id, e.target.value)} />
        </Row>
      )}
      {node.children.length > 0 && (
        <button style={{ ...styles.ghost, width: '100%', marginTop: 4 }} onClick={() => store.ungroupNode(node.id)}>
          ⤢ Desagrupar (⌘⇧G)
        </button>
      )}
    </Section>
  )
}

// --- Layout: display, position, flex/grid del contenedor Y del hijo ---
function LayoutPanel({ store, node, dep }: { store: EditorStore; node: Node; dep: unknown }) {
  const c = useComputed(node.id, ['display', 'flex-direction', 'flex-wrap', 'position', 'z-index'], dep)
  const mode = displayOf(c.display ?? '', c['flex-direction'] ?? '')
  const isFlex = mode === 'flex-row' || mode === 'flex-col'
  const isGrid = mode === 'grid'
  const positioned = (c.position ?? 'static') !== 'static'
  return (
    <Section title="Layout">
      <Row label="Display">
        <Segmented<DisplayMode>
          value={mode}
          options={[
            ['block', IconBlock, 'Block (flujo normal)'],
            ['flex-row', IconRow, 'Flex fila (autolayout horizontal)'],
            ['flex-col', IconCol, 'Flex columna (autolayout vertical)'],
            ['grid', IconGrid, 'Grid'],
            ['none', IconHidden, 'Oculto (display none)'],
          ]}
          onChange={(m) => store.setNodeStyleProps(node.id, displayDecls(m))}
        />
      </Row>
      {isFlex && (
        <>
          <CssRow label="Wrap" prop="flex-wrap" node={node} store={store} dep={dep} options={WRAP_OPTS} />
          <CssRow label="Align" prop="align-items" node={node} store={store} dep={dep} />
          <CssRow label="Justify" prop="justify-content" node={node} store={store} dep={dep} />
        </>
      )}
      {isGrid && (
        <>
          <CssRow label="Columnas" prop="grid-template-columns" node={node} store={store} dep={dep} />
          <CssRow label="Flow" prop="grid-auto-flow" node={node} store={store} dep={dep} options={FLOW_OPTS} />
          <CssRow label="Align" prop="align-items" node={node} store={store} dep={dep} />
          <CssRow label="Justify" prop="justify-items" node={node} store={store} dep={dep} options={CSS_OPTIONS['align-items']} />
        </>
      )}
      {(isFlex || isGrid) && <CssRow label="Gap" prop="gap" node={node} store={store} dep={dep} />}
      <CssRow label="Position" prop="position" node={node} store={store} dep={dep} />
      {positioned && (
        <>
          <SidesRow label="Inset" props={['top', 'right', 'bottom', 'left']} node={node} store={store} dep={dep} />
          <CssRow label="z-index" prop="z-index" node={node} store={store} dep={dep} options={Z_OPTS} />
        </>
      )}
    </Section>
  )
}

/**
 * Controles del nodo COMO HIJO de su contenedor. Sin esto, un bento cuyo CSS
 * coloca cada tarjeta con `grid-column`/`grid-row` explícitos es inarreglable
 * desde el panel: cambias las columnas del padre y las tarjetas siguen clavadas
 * en su celda (o se encinan). Aquí se ven y se quitan.
 */
function ChildLayoutPanel({ store, node, dep }: { store: EditorStore; node: Node; dep: unknown }) {
  const parentDisplay = useParentComputed(node.id, ['display', 'flex-direction'], dep)
  const pMode = displayOf(parentDisplay.display ?? '', parentDisplay['flex-direction'] ?? '')
  if (pMode !== 'grid' && pMode !== 'flex-row' && pMode !== 'flex-col') return null
  return (
    <Section title="En el contenedor" collapsible defaultOpen={pMode === 'grid'}>
      <CssRow label="Self ↕" prop="align-self" node={node} store={store} dep={dep} options={SELF_OPTS} />
      <CssRow label="Self ↔" prop="justify-self" node={node} store={store} dep={dep} options={JUSTIFY_SELF_OPTS} />
      {pMode === 'grid' ? (
        <>
          <CssRow label="Columna" prop="grid-column" node={node} store={store} dep={dep} options={SPAN_OPTS} />
          <CssRow label="Fila" prop="grid-row" node={node} store={store} dep={dep} options={SPAN_OPTS} />
        </>
      ) : (
        <>
          <CssRow label="Grow" prop="flex-grow" node={node} store={store} dep={dep} options={GROW_OPTS} />
          <CssRow label="Shrink" prop="flex-shrink" node={node} store={store} dep={dep} options={GROW_OPTS} />
        </>
      )}
      <CssRow label="Orden" prop="order" node={node} store={store} dep={dep} options={ORDER_OPTS} />
    </Section>
  )
}

// --- Typography ---
function TypographyPanel({ store, node, dep }: { store: EditorStore; node: Node; dep: unknown }) {
  return (
    <Section title="Tipografía">
      <CssRow label="Size" prop="font-size" node={node} store={store} dep={dep} />
      <CssRow label="Leading" prop="line-height" node={node} store={store} dep={dep} />
      <CssRow label="Weight" prop="font-weight" node={node} store={store} dep={dep} />
      <CssRow label="Tracking" prop="letter-spacing" node={node} store={store} dep={dep} />
      <CssRow label="Align" prop="text-align" node={node} store={store} dep={dep} />
    </Section>
  )
}

// --- Size & Spacing ---
function SizeSpacingPanel({ store, node, dep }: { store: EditorStore; node: Node; dep: unknown }) {
  const c = useComputed(node.id, ['width', 'height', 'overflow'], dep)
  const sizingOpts: [Sizing, string][] = [
    ['hug', 'Hug'],
    ['fixed', 'Fixed'],
    ['fill', 'Fill'],
  ]
  const sizeRow = (label: string, prop: 'width' | 'height') => {
    const inline = inlineValue(node.style, prop)
    const effective = inline ?? c[prop] ?? ''
    const s = inline ? sizingOf(inline) : 'hug'
    const px = Math.round(parseFloat(c[prop] ?? '0')) || 0
    return (
      <Row label={label}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Segmented<Sizing> value={s} options={sizingOpts} onChange={(next) => store.setNodeStyleProp(node.id, prop, next === 'hug' ? null : sizingValue(next, px))} />
          </div>
          {s === 'fixed' && (
            <input
              style={{ ...styles.input, width: 62 }}
              value={parseFloat(effective) || 0}
              onChange={(e) => store.setNodeStyleProp(node.id, prop, `${e.target.value || 0}px`)}
            />
          )}
        </div>
      </Row>
    )
  }
  return (
    <Section title="Size & Spacing">
      {sizeRow('W', 'width')}
      {sizeRow('H', 'height')}
      <SidesRow label="Padding" props={['padding-top', 'padding-right', 'padding-bottom', 'padding-left']} node={node} store={store} dep={dep} />
      <SidesRow label="Margin" props={['margin-top', 'margin-right', 'margin-bottom', 'margin-left']} node={node} store={store} dep={dep} />
      <CssRow label="Overflow" prop="overflow" node={node} store={store} dep={dep} />
    </Section>
  )
}

// --- Colors + border/radius ---
function ColorsPanel({ store, node, dep }: { store: EditorStore; node: Node; dep: unknown }) {
  return (
    <Section title="Color">
      <CssColorRow label="Text" prop="color" node={node} store={store} dep={dep} />
      <CssColorRow label="Fondo" prop="background-color" node={node} store={store} dep={dep} />
      <CssRow label="Borde" prop="border-width" node={node} store={store} dep={dep} onExtra={{ 'border-style': 'solid' }} />
      <CssColorRow label="Color borde" prop="border-color" node={node} store={store} dep={dep} />
      <CssRow label="Radius" prop="border-radius" node={node} store={store} dep={dep} />
    </Section>
  )
}

// --- Effects ---
function EffectsPanel({ store, node, dep }: { store: EditorStore; node: Node; dep: unknown }) {
  return (
    <Section title="Efectos">
      <CssRow label="Sombra" prop="box-shadow" node={node} store={store} dep={dep} />
      <CssRow label="Opacidad" prop="opacity" node={node} store={store} dep={dep} />
    </Section>
  )
}

// --- primitivas CSS-first -------------------------------------------------
const WRAP_OPTS: Opt[] = [['nowrap', 'no'], ['wrap', 'sí'], ['wrap-reverse', 'reverse']]
const FLOW_OPTS: Opt[] = [['row', 'filas'], ['column', 'columnas'], ['row dense', 'filas dense']]
const Z_OPTS: Opt[] = [['0', '0'], ['1', '1'], ['10', '10'], ['50', '50'], ['-1', '-1']]
const SELF_OPTS: Opt[] = [['auto', 'auto'], ['flex-start', 'start'], ['center', 'center'], ['flex-end', 'end'], ['stretch', 'stretch']]
const GROW_OPTS: Opt[] = [['0', '0'], ['1', '1'], ['2', '2']]
const ORDER_OPTS: Opt[] = [['-1', 'primero'], ['0', 'normal'], ['1', 'después']]
const SPAN_OPTS: Opt[] = [
  ['auto', 'auto'], ['span 1', 'span 1'], ['span 2', 'span 2'], ['span 3', 'span 3'],
  ['span 4', 'span 4'], ['span 5', 'span 5'], ['span 6', 'span 6'], ['1 / -1', 'todo el ancho'],
]
const JUSTIFY_SELF_OPTS: Opt[] = [['auto', 'auto'], ['start', 'start'], ['center', 'center'], ['end', 'end'], ['stretch', 'llenar']]

/** Valor de una declaración dentro del `style` inline del nodo, o null. */
function inlineValue(style: string | undefined, prop: string): string | null {
  if (!style) return null
  for (const decl of style.split(';')) {
    const i = decl.indexOf(':')
    if (i < 0) continue
    if (decl.slice(0, i).trim().toLowerCase() === prop) return decl.slice(i + 1).trim()
  }
  return null
}

/** Lee del DOM VIVO. `dep` (el doc) fuerza la relectura tras cada cambio, incluido
 *  el cambio de TEMA — que no toca el nodo pero sí sus colores computados. */
function useComputed(nodeId: string, props: string[], dep: unknown): Record<string, string> {
  const [v, setV] = useState<Record<string, string>>({})
  const key = props.join('|')
  useLayoutEffect(() => {
    const el = nodeEl(nodeId)
    if (!el) {
      setV({})
      return
    }
    const cs = getComputedStyle(el)
    const out: Record<string, string> = {}
    for (const p of key.split('|')) out[p] = cs.getPropertyValue(p).trim()
    setV(out)
  }, [nodeId, key, dep])
  return v
}
function useParentComputed(nodeId: string, props: string[], dep: unknown): Record<string, string> {
  const [v, setV] = useState<Record<string, string>>({})
  const key = props.join('|')
  useLayoutEffect(() => {
    const el = nodeEl(nodeId)?.parentElement
    if (!el) {
      setV({})
      return
    }
    const cs = getComputedStyle(el)
    const out: Record<string, string> = {}
    for (const p of key.split('|')) out[p] = cs.getPropertyValue(p).trim()
    setV(out)
  }, [nodeId, key, dep])
  return v
}

/**
 * Fila de una propiedad CSS. Muestra el valor EFECTIVO (venga de una clase, de
 * una regla del artefacto o de inline) y al elegir escribe la declaración inline,
 * que gana sobre todo lo demás. "—" borra la declaración y devuelve el control al
 * CSS del autor.
 */
function CssRow({
  label,
  prop,
  node,
  store,
  dep,
  options,
  onExtra,
}: {
  label: string
  prop: string
  node: Node
  store: EditorStore
  dep: unknown
  options?: Opt[]
  onExtra?: Record<string, string>
}) {
  // Cada fila lee SU propiedad: antes dependía de que el panel padre la incluyera
  // en su lista de computed y bastaba un olvido (align-items) para que el control
  // mostrara "—" con el valor real colgando del placeholder.
  const computed = useComputed(node.id, [prop], dep)
  const opts = options ?? CSS_OPTIONS[prop] ?? []
  const inline = inlineValue(node.style, prop)
  const effective = (inline ?? computed[prop] ?? '').trim()
  // El select refleja el valor EFECTIVO, esté fijado aquí o heredado del CSS del
  // autor. En gris = heredado (no hay declaración nuestra); en blanco = fijado.
  const value = optionForValue(opts, effective)
  const pinned = !!inline
  return (
    <Row label={label}>
      <select
        style={{ ...styles.select, color: pinned || !value ? '#e5e7eb' : '#9ca3af' }}
        value={value}
        title={pinned ? `${prop}: ${effective}` : `heredado — ${prop}: ${effective}`}
        onChange={(e) => {
          const v = e.target.value
          if (onExtra && v) store.setNodeStyleProps(node.id, { [prop]: v, ...onExtra })
          else store.setNodeStyleProp(node.id, prop, v || null)
        }}
      >
        <option value="">{effective && !value && effective !== 'normal' && effective !== 'auto' ? `— (${shortValue(effective)})` : '—'}</option>
        {opts.map(([v, l]) => (
          <option key={v} value={v}>{l}</option>
        ))}
      </select>
    </Row>
  )
}

/** Acorta valores computados largos para que quepan en el select. */
function shortValue(v: string): string {
  return v.length > 22 ? v.slice(0, 21) + '…' : v
}

/** Color: tokens del tema + color libre, siempre sobre la propiedad CSS real. */
function CssColorRow({ label, prop, node, store, dep }: { label: string; prop: string; node: Node; store: EditorStore; dep: unknown }) {
  const computed = useComputed(node.id, [prop], dep)
  const inline = inlineValue(node.style, prop)
  const token = COLOR_TOKENS.some(([v]) => v === inline) ? inline! : ''
  const hex = toHex(inline ?? '') ?? toHex(computed[prop] ?? '')
  return (
    <Row label={label}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <select style={{ ...styles.select, flex: 1, minWidth: 0 }} value={token} onChange={(e) => store.setNodeStyleProp(node.id, prop, e.target.value || null)}>
          <option value="">{inline && !token ? `— (${shortValue(inline)})` : '—'}</option>
          {COLOR_TOKENS.map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
        <label title="Color libre" style={{ position: 'relative', width: 26, height: 26, flexShrink: 0, borderRadius: 6, border: '1px solid #262b36', overflow: 'hidden', cursor: 'pointer', background: hex ?? 'repeating-conic-gradient(#2a2f3a 0% 25%, #1a1d24 0% 50%) 50%/8px 8px' }}>
          <input type="color" value={hex ?? '#000000'} onChange={(e) => store.setNodeStyleProp(node.id, prop, e.target.value)} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, cursor: 'pointer' }} />
        </label>
      </div>
    </Row>
  )
}

/** Cuatro lados (padding/margin/inset) en px, con el valor efectivo de placeholder. */
function SidesRow({ label, props, node, store, dep }: { label: string; props: string[]; node: Node; store: EditorStore; dep: unknown }) {
  const c = useComputed(node.id, props, dep)
  return (
    <Row label={label}>
      <div style={{ display: 'flex', gap: 4 }}>
        {props.map((p, i) => {
          const inline = inlineValue(node.style, p)
          const eff = (inline ?? c[p] ?? '').replace('px', '')
          return (
            <input
              key={p}
              title={p}
              style={{ ...styles.input, padding: '5px 4px', textAlign: 'center' }}
              placeholder={['T', 'R', 'B', 'L'][i]}
              value={eff === 'auto' ? 'auto' : Math.round(parseFloat(eff) || 0)}
              onChange={(e) => {
                const raw = e.target.value.trim()
                store.setNodeStyleProp(node.id, p, raw === '' ? null : raw === 'auto' ? 'auto' : `${parseFloat(raw) || 0}px`)
              }}
            />
          )
        })}
      </div>
    </Row>
  )
}

/**
 * Imagen y fondo. Dos modos sobre el MISMO panel:
 * - "Imagen" edita `<img>.src` (sólo disponible si el nodo es un <img>).
 * - "Fondo" edita el `background-image` de cualquier nodo — el caso del hero
 *   generado por la IA, que es un <div> con la foto de fondo.
 *
 * Portado del editor clásico de Denik (`EditorRightSidebar`), incluidos los dos
 * escapes a la directiva de layout del generador ("Ancho completo" / "Foto de
 * fondo") y el salto al contenedor padre.
 */
function ImagePanel({ store, node, doc, imageProvider }: { store: EditorStore; node: Node; doc: Doc; imageProvider?: ImageProvider }) {
  const isImg = node.tag === 'img'
  const [mode, setMode] = useState<'img' | 'bg'>(isImg ? 'img' : 'bg')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState<'gen' | 'search' | 'upload' | null>(null)
  const [results, setResults] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const [dragging, setDragging] = useState(false)
  // Un nodo que no es <img> no puede estar en modo "Imagen": al cambiar de
  // selección el modo se recalcula (el key del panel fuerza el remount).
  const effMode = isImg ? mode : 'bg'
  const bgUrl = backgroundUrl(node)
  const current = effMode === 'img' ? (node.src ?? '') : (bgUrl ?? '')
  const parent = parentOf(doc, node.id)

  const apply = (src: string) => {
    setError(null)
    if (effMode === 'img') store.updateNode(node.id, { src })
    else setBackground(store, node.id, src)
  }

  async function generate() {
    if (!imageProvider?.generate || !prompt.trim() || busy) return
    setBusy('gen')
    try {
      apply(await imageProvider.generate(prompt.trim()))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo generar la imagen')
    } finally {
      setBusy(null)
    }
  }
  async function search() {
    if (!imageProvider?.search || !prompt.trim() || busy) return
    setBusy('search')
    try {
      setResults(await imageProvider.search(prompt.trim()))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo buscar')
    } finally {
      setBusy(null)
    }
  }
  async function upload(file: File | undefined | null) {
    if (!file || !imageProvider?.upload || busy) return
    if (!file.type.startsWith('image/')) {
      setError('Ese archivo no es una imagen.')
      return
    }
    setBusy('upload')
    setError(null)
    try {
      apply(await imageProvider.upload(file))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo subir la imagen')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Section
      title="Imagen y fondo"
      action={
        parent ? (
          <button title={`Seleccionar el contenedor <${parent.tag}>`} style={{ ...styles.iconBtn, width: 'auto', padding: '0 5px', fontFamily: 'monospace', fontSize: 10 }} onClick={() => store.select(parent.id)}>
            ↑ {parent.tag}
          </button>
        ) : undefined
      }
    >
      <div style={{ ...styles.segmented, marginBottom: 6 }}>
        {([['img', 'Imagen'], ['bg', 'Fondo']] as const).map(([id, label]) => (
          <button
            key={id}
            disabled={id === 'img' && !isImg}
            title={id === 'img' && !isImg ? 'Este nodo no es una <img>' : undefined}
            style={{ ...styles.seg, cursor: id === 'img' && !isImg ? 'not-allowed' : 'pointer', opacity: id === 'img' && !isImg ? 0.4 : 1, ...(effMode === id ? styles.segActive : null) }}
            onClick={() => setMode(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {/*
        Zona de imagen: preview y subida son EL MISMO objeto. Un botón "subir"
        separado del preview obliga a mirar dos sitios para entender el estado;
        aquí la caja muestra lo que hay y acepta que le sueltes un archivo
        encima. Relación 16:9 fija para que el panel no salte al cambiar de
        imagen, sobre damero para distinguir "transparente" de "vacío".
      */}
      {imageProvider?.upload ? (
        <label
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            position: 'relative', aspectRatio: '16 / 9', marginBottom: 6,
            borderRadius: 8, overflow: 'hidden', cursor: busy ? 'progress' : 'pointer',
            border: `1px ${dragging ? 'solid' : 'dashed'} ${dragging ? '#8b5cf6' : '#2a2f3a'}`,
            background: dragging ? 'rgba(139,92,246,.08)' : CHECKERBOARD,
            transition: 'border-color .12s, background .12s',
          }}
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); upload(e.dataTransfer.files?.[0]) }}
        >
          {current && !dragging && (
            <img src={current} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} onError={() => setError('No se pudo cargar esa imagen.')} />
          )}
          <span style={{
            position: 'relative', display: 'flex', alignItems: 'center', gap: 5,
            fontSize: 11, fontWeight: 600, color: '#e5e7eb',
            // Sobre una foto el texto necesita su propio fondo para leerse.
            background: current && !dragging ? 'rgba(13,15,20,.78)' : 'transparent',
            padding: current && !dragging ? '4px 8px' : 0, borderRadius: 6,
          }}>
            {busy === 'upload' ? (
              <><span className="ce-spinner" /> Subiendo…</>
            ) : dragging ? (
              'Suelta la imagen'
            ) : (
              <>{IconUpload} {current ? 'Reemplazar' : effMode === 'bg' ? 'Subir imagen de fondo' : 'Subir imagen'}</>
            )}
          </span>
          <input type="file" accept="image/*" style={{ display: 'none' }} disabled={!!busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; upload(f) }} />
        </label>
      ) : (
        current && <img src={current} alt="" style={{ width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: 8, marginBottom: 6, background: CHECKERBOARD }} />
      )}

      {/*
        Escapes a la directiva de layout del generador, que encierra todo en
        `max-w-7xl mx-auto px-4` + grid. Se nombran por LO QUE HACEN: los
        títulos anteriores ("Ancho completo", "Foto de fondo") describían un
        resultado abstracto que nadie relacionaba con su problema.
      */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
        <button style={styles.ghost} title="Quita el ancho máximo y el padding lateral de este elemento y de sus contenedores, para que la imagen llegue a los bordes" onClick={() => { setError(null); makeFullBleed(store, doc, node.id) }}>
          Quitar márgenes
        </button>
        <button
          style={{ ...styles.ghost, opacity: isImg ? 1 : 0.4, cursor: isImg ? 'pointer' : 'not-allowed' }}
          disabled={!isImg}
          title="Manda esta foto al fondo de su sección y le pone un degradado para que el texto siga legible. La imagen original queda oculta: la recuperas desde el ojito de la capa"
          onClick={() => setError(makeHeroBackground(store, doc, node.id))}
        >
          Mandar al fondo
        </button>
        {effMode === 'bg' && bgUrl && (
          <button style={{ ...styles.ghost, gridColumn: '1 / -1' }} onClick={() => { setError(null); clearBackground(store, node) }}>
            Quitar el fondo
          </button>
        )}
      </div>

      <Row label="URL">
        <div style={{ display: 'flex', gap: 4 }}>
          <input
            style={{ ...styles.input, flex: 1, minWidth: 0 }}
            placeholder={current || 'https://…'}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && /^https?:\/\//.test(url.trim())) { apply(url.trim()); setUrl('') }
            }}
          />
          <button
            style={{ ...styles.iconBtn, opacity: /^https?:\/\//.test(url.trim()) ? 1 : 0.4 }}
            disabled={!/^https?:\/\//.test(url.trim())}
            title={effMode === 'bg' ? 'Usar como fondo' : 'Usar esta URL'}
            onClick={() => { apply(url.trim()); setUrl('') }}
          >
            {IconCheck}
          </button>
        </div>
      </Row>
      {url.trim() && !/^https?:\/\//.test(url.trim()) && (
        <div style={{ fontSize: 10, color: '#f59e0b', marginBottom: 4 }}>La URL debe empezar con http:// o https://</div>
      )}
      {error && <div style={{ fontSize: 10, color: '#f87171', marginBottom: 4 }}>{error}</div>}

      {imageProvider && (imageProvider.generate || imageProvider.search) && (
        <>
          <textarea style={{ ...styles.input, minHeight: 40, resize: 'vertical' }} placeholder="describe la imagen…" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            {imageProvider.generate && (
              <button style={{ ...styles.primary, marginTop: 0, flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }} disabled={!!busy} onClick={generate}>
                {busy === 'gen' ? <><span className="ce-spinner" /> Generando…</> : <>{IconSparkle} Generar</>}
              </button>
            )}
            {imageProvider.search && (
              <button style={{ ...styles.ghost, flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }} disabled={!!busy} onClick={search}>
                {busy === 'search' ? 'Buscando…' : <>{IconSearch} Buscar</>}
              </button>
            )}
          </div>
        </>
      )}
      {results.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4, marginTop: 6 }}>
          {results.map((r) => (
            <img key={r} src={r} alt="" onClick={() => apply(r)} style={{ width: '100%', height: 48, objectFit: 'cover', borderRadius: 4, cursor: 'pointer', border: current === r ? '2px solid #8b5cf6' : '1px solid #262b36' }} />
          ))}
        </div>
      )}
    </Section>
  )
}

function RefinePanel({ store, node, doc, refineProvider }: { store: EditorStore; node: Node; doc: Doc; refineProvider: RefineProvider }) {
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<ChangeSummary | null>(null)
  const models = refineProvider.models ?? []
  const [modelId, setModelId] = useState(refineProvider.defaultModelId ?? models[0]?.id)

  async function run() {
    if (!instruction.trim() || busy) return
    setBusy(true)
    setError(null)
    setSummary(null)
    const before = node
    const currentHtml = nodeSubtreeToHtml(node)
    // Todo el refine (parciales incluidos) es UNA entrada de undo: sin esto ⌘Z
    // deshacía el streaming token por token.
    store.beginTransaction()
    try {
      const apply = (html: string) => {
        const parsed = htmlToNode(html, node.id)
        // El merge conserva los data-id de los descendientes aunque el modelo
        // los haya omitido — es lo que evita que cambiar un h2 sacuda la sección.
        if (parsed) store.mergeNodeSubtree(node.id, parsed)
      }
      const finalHtml = await refineProvider.refineNode(
        {
          nodeId: node.id,
          instruction: instruction.trim(),
          currentHtml,
          context: refineContext(doc, node.id),
          modelId,
        },
        // Sólo se pinta un parcial cuando el elemento raíz ya cerró: aplicar HTML
        // a medias desarma la sección en pantalla en cada chunk.
        { onPartial: (p) => { if (isCompleteElement(p)) apply(p) } },
      )
      apply(finalHtml)
      const after = store.findNodePublic(node.id)
      if (after) setSummary(summarizeChange(before, after))
      setInstruction('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo refinar')
    } finally {
      store.endTransaction()
      setBusy(false)
    }
  }

  return (
    <Section title="Refinar con IA">
      <textarea
        style={{ ...styles.input, minHeight: 52, resize: 'vertical' }}
        placeholder="haz el título más grande, fondo oscuro…"
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        disabled={busy}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run()
        }}
      />
      {models.length > 0 && (
        <ModelChip
          models={models}
          value={modelId}
          disabled={busy}
          manageKeysHref={refineProvider.manageKeysHref}
          onChange={(id) => {
            setModelId(id)
            refineProvider.onModelChange?.(id)
          }}
        />
      )}
      <button
        className={busy ? 'ce-refining' : undefined}
        style={{ ...styles.primary, cursor: busy ? 'progress' : 'pointer', opacity: busy ? 0.85 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
        disabled={busy}
        title="⌘↵"
        onClick={run}
      >
        {busy ? (
          <>
            <span className="ce-spinner" /> Refinando…
          </>
        ) : (
          <>
            {IconSparkle} Aplicar a este nodo
          </>
        )}
      </button>
      {error && <div style={{ fontSize: 10, color: '#f87171', marginTop: 6 }}>{error}</div>}
      {summary && (
        <div style={{ marginTop: 8, padding: '7px 8px', background: '#0d0f14', border: '1px solid #262b36', borderRadius: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginBottom: summary.lines.length ? 5 : 0 }}>
            <span style={{ fontSize: 11, color: '#6ee7b7' }}>Listo</span>
            <button style={{ ...styles.chip, color: '#c4b5fd' }} onClick={() => { store.undo(); setSummary(null) }}>
              Deshacer
            </button>
          </div>
          {summary.lines.map((l) => (
            <div key={l} style={{ fontSize: 10, color: '#9ca3af', fontFamily: 'monospace', lineHeight: 1.5, overflowWrap: 'anywhere' }}>
              {l}
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}

/** ¿El HTML acumulado ya cierra su elemento raíz? Evita pintar tags a medias. */
function isCompleteElement(html: string): boolean {
  const s = html.trim()
  const m = /^<([a-zA-Z][\w-]*)/.exec(s)
  if (!m) return false
  const tag = m[1].toLowerCase()
  if (VOID_TAGS.has(tag)) return /\/?>\s*$/.test(s)
  return new RegExp(`</${tag}\\s*>$`, 'i').test(s)
}
const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'source', 'meta', 'link'])

interface ChangeSummary {
  lines: string[]
}
/** Resumen legible de lo que cambió, para que el refine no sea una caja negra. */
function summarizeChange(before: Node, after: Node): ChangeSummary {
  const lines: string[] = []
  const b = new Set(classList(before.cls))
  const a = new Set(classList(after.cls))
  const added = [...a].filter((c) => !b.has(c))
  const removed = [...b].filter((c) => !a.has(c))
  if (added.length) lines.push(`+ ${added.join(' ')}`)
  if (removed.length) lines.push(`− ${removed.join(' ')}`)
  if (before.text !== after.text && after.text) lines.push(`texto: “${truncate(after.text, 40)}”`)
  if (before.src !== after.src) lines.push(after.src ? `imagen: ${truncate(after.src, 40)}` : 'imagen quitada')
  const nBefore = countNodes(before)
  const nAfter = countNodes(after)
  if (nBefore !== nAfter) lines.push(`${nAfter > nBefore ? '+' : '−'}${Math.abs(nAfter - nBefore)} elementos`)
  if (!lines.length) lines.push('sin cambios visibles')
  return { lines }
}
function countNodes(n: Node): number {
  return 1 + n.children.reduce((acc, c) => acc + countNodes(c), 0)
}
function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/**
 * Chip compacto de modelo al pie del textarea. Deliberadamente NO es un `<select>`
 * de ancho completo: la elección de modelo es secundaria frente a la instrucción,
 * y un control grande la haría parecer un paso obligatorio.
 */
function ModelChip({
  models,
  value,
  disabled,
  manageKeysHref,
  onChange,
}: {
  models: ModelOption[]
  value?: string
  disabled?: boolean
  manageKeysHref?: string
  onChange: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  // El menú se ancla con `position: fixed` a partir del rect del botón: el panel
  // del inspector es un contenedor con `overflow-y: auto`, así que un menú
  // `absolute` queda RECORTADO y las opciones de abajo son inalcanzables.
  const [rect, setRect] = useState<DOMRect | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const active = models.find((m) => m.id === value) ?? models[0]
  const groups = models.reduce<Record<string, ModelOption[]>>((acc, m) => {
    ;(acc[m.provider] ??= []).push(m)
    return acc
  }, {})
  const MENU_W = 210
  const MENU_MAX_H = 260
  // Si no cabe abajo, abre hacia arriba.
  const below = rect ? window.innerHeight - rect.bottom : 0
  const dropUp = rect ? below < MENU_MAX_H && rect.top > below : false

  const toggle = () => {
    if (disabled) return
    setRect(btnRef.current?.getBoundingClientRect() ?? null)
    setOpen((o) => !o)
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
      <button
        ref={btnRef}
        style={{ ...styles.chip, display: 'inline-flex', alignItems: 'center', gap: 4, opacity: disabled ? 0.5 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}
        disabled={disabled}
        title="Modelo para este refinamiento"
        onClick={toggle}
      >
        {active?.label ?? 'modelo'}
        {active?.ownKey && <span style={styles.keyBadge}>tu llave</span>}
        <span style={{ opacity: 0.6 }}>▾</span>
      </button>
      {open && rect && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 19 }} onClick={() => setOpen(false)} />
          <div
            style={{
              ...styles.menu,
              position: 'fixed',
              width: MENU_W,
              maxHeight: MENU_MAX_H,
              // Alineado a la derecha del chip, sin salirse de la ventana.
              left: Math.max(8, Math.min(rect.right - MENU_W, window.innerWidth - MENU_W - 8)),
              ...(dropUp ? { bottom: window.innerHeight - rect.top + 4, top: 'auto' } : { top: rect.bottom + 4 }),
            }}
          >
            {Object.entries(groups).map(([provider, list]) => (
              <div key={provider}>
                <div style={{ ...styles.sectionTitle, margin: '6px 8px 3px' }}>{provider}</div>
                {list.map((m) => (
                  <button
                    key={m.id}
                    style={{ ...styles.menuItem, background: m.id === active?.id ? '#3730a3' : 'transparent' }}
                    onClick={() => {
                      onChange(m.id)
                      setOpen(false)
                    }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      {m.label}
                      {m.ownKey && <span style={styles.keyBadge}>tu llave</span>}
                    </span>
                    {m.hint && <span style={{ display: 'block', fontSize: 9, color: '#6b7280' }}>{m.hint}</span>}
                  </button>
                ))}
              </div>
            ))}
            {manageKeysHref && (
              <a href={manageKeysHref} style={{ ...styles.menuItem, display: 'block', color: '#a78bfa', borderTop: '1px solid #262b36', marginTop: 4, paddingTop: 7, textDecoration: 'none' }}>
                Gestionar llaves →
              </a>
            )}
          </div>
        </>
      )}
    </div>
  )
}

const RADIUS_PRESETS: [string, string][] = [
  ['0rem', 'Sharp'],
  ['0.25rem', 'Slight'],
  ['0.5rem', 'Balanced'],
  ['0.75rem', 'Soft'],
  ['1.25rem', 'Round'],
]
const SWATCHES: [string, string][] = [
  ['background', 'Fondo'],
  ['foreground', 'Texto'],
  ['primary', 'Primary'],
  ['primary-foreground', 'on-Primary'],
  ['secondary', 'Secondary'],
  ['secondary-foreground', 'on-Secondary'],
  ['muted', 'Muted'],
  ['muted-foreground', 'on-Muted'],
  ['accent', 'Accent'],
  ['border', 'Borde'],
]

function ThemePanel({ store, state, defaultOpen = true }: { store: EditorStore; state: EditorState; defaultOpen?: boolean }) {
  const t = state.doc.theme
  const tokens = activeTokens(t)
  return (
    <Section title="Tema" collapsible defaultOpen={defaultOpen}>
      <Row label="Modo">
        <Segmented<'light' | 'dark'> value={t.mode} options={[['light', '☀ Light'], ['dark', '☾ Dark']]} onChange={(mode) => store.setTheme({ mode })} />
      </Row>
      <Row label="Heading">
        <FontSelect value={t.fonts.heading} onChange={(f) => store.setTheme({ fonts: { ...t.fonts, heading: f } })} />
      </Row>
      <Row label="Body">
        <FontSelect value={t.fonts.body} onChange={(f) => store.setTheme({ fonts: { ...t.fonts, body: f } })} />
      </Row>
      <Row label="Radius">
        <select style={styles.select} value={t.radius} onChange={(e) => store.setTheme({ radius: e.target.value })}>
          {RADIUS_PRESETS.map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
      </Row>
      <Row label="Paleta">
        <select
          style={styles.select}
          value={PALETTE_PRESETS.some((p) => p.name === t.name) ? t.name : ''}
          onChange={(e) => {
            const p = PALETTE_PRESETS.find((x) => x.name === e.target.value)
            if (p) store.applyPalette(p)
          }}
        >
          {!PALETTE_PRESETS.some((p) => p.name === t.name) && <option value="">{t.name}</option>}
          {PALETTE_PRESETS.map((p) => (
            <option key={p.name} value={p.name}>{p.name}</option>
          ))}
        </select>
      </Row>
      <div style={{ marginTop: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={styles.sectionTitle}>{t.name} · {t.mode}</span>
          <button
            title="Paleta aleatoria (conocidas, con contraste)"
            style={styles.iconBtn}
            onClick={() => store.applyPalette(PALETTE_PRESETS[Math.floor(Math.random() * PALETTE_PRESETS.length)])}
          >
            🎲
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          {SWATCHES.map(([key, label]) => {
            const hex = normalizeHex(tokens[key])
            return (
              <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#9ca3af', cursor: 'pointer', position: 'relative' }}>
                <span style={{ width: 22, height: 22, borderRadius: 5, border: '1px solid #3a3f4a', background: hex, flexShrink: 0, boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.04)' }} />
                <input type="color" value={hex} onChange={(e) => store.setToken(key, e.target.value)} style={{ position: 'absolute', left: 0, top: 0, width: 22, height: 22, opacity: 0, cursor: 'pointer' }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {label}
                  <span style={{ display: 'block', fontSize: 9, color: '#6b7280', fontFamily: 'monospace' }}>{tokens[key] ?? '—'}</span>
                </span>
              </label>
            )
          })}
        </div>
      </div>
    </Section>
  )
}

// Custom dropdown so each option previews in its own typeface (native <option>
// font-family is unreliable, esp. Safari).
function FontSelect({ value, onChange }: { value: string; onChange: (f: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ position: 'relative' }}>
      <button style={{ ...styles.select, fontFamily: value, textAlign: 'left', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }} onClick={() => setOpen((o) => !o)}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
        <span style={{ opacity: 0.6, marginLeft: 4 }}>▾</span>
      </button>
      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 19 }} onClick={() => setOpen(false)} />
          <div style={styles.menu}>
            {FONT_OPTIONS.map((f) => (
              <button
                key={f}
                style={{ ...styles.menuItem, fontFamily: f, background: f === value ? '#3730a3' : 'transparent' }}
                onClick={() => {
                  onChange(f)
                  setOpen(false)
                }}
              >
                {f}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function normalizeHex(v: string | undefined): string {
  if (!v) return '#000000'
  const s = v.trim()
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s : '#000000'
}

// --- primitivas de UI ---
function Section({ title, children, action, collapsible, defaultOpen = true }: { title: string; children: React.ReactNode; action?: React.ReactNode; collapsible?: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const shown = !collapsible || open
  return (
    <div style={styles.section}>
      <div style={{ ...styles.sectionTitle, display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: shown ? 8 : 0 }}>
        {collapsible ? (
          <button
            onClick={() => setOpen((o) => !o)}
            style={{ ...styles.sectionTitle, marginBottom: 0, display: 'flex', alignItems: 'center', gap: 5, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}
          >
            <span style={{ display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }}>▸</span>
            {title}
          </button>
        ) : (
          <span>{title}</span>
        )}
        {action}
      </div>
      {shown && children}
    </div>
  )
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={styles.row}>
      <span style={styles.rowLabel}>{label}</span>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  )
}
function Segmented<T extends string>({ value, options, onChange }: { value: T; options: (readonly [T, React.ReactNode] | readonly [T, React.ReactNode, string])[]; onChange: (v: T) => void }) {
  return (
    <div style={styles.segmented}>
      {options.map((opt) => (
        <button key={opt[0]} title={opt[2] ?? (typeof opt[1] === 'string' ? (opt[1] as string) : undefined)} style={{ ...styles.seg, display: 'flex', alignItems: 'center', justifyContent: 'center', ...(opt[0] === value ? styles.segActive : null) }} onClick={() => onChange(opt[0])}>
          {opt[1]}
        </button>
      ))}
    </div>
  )
}

// Display icons (crisp SVG instead of ambiguous unicode glyphs)
const svg = (children: React.ReactNode) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
)
const IconBlock = svg(<><rect x="4" y="6" width="16" height="4" rx="1" /><rect x="4" y="14" width="16" height="4" rx="1" /></>)
const IconRow = svg(<><rect x="3" y="6" width="7" height="12" rx="1" /><rect x="14" y="6" width="7" height="12" rx="1" /></>)
const IconCol = svg(<><rect x="6" y="3" width="12" height="7" rx="1" /><rect x="6" y="14" width="12" height="7" rx="1" /></>)
const IconGrid = svg(<><rect x="4" y="4" width="7" height="7" rx="1" /><rect x="13" y="4" width="7" height="7" rx="1" /><rect x="4" y="13" width="7" height="7" rx="1" /><rect x="13" y="13" width="7" height="7" rx="1" /></>)
/** Damero: distingue "imagen transparente" de "no hay imagen". */
const CHECKERBOARD = 'repeating-conic-gradient(#1a1d24 0% 25%, #0d0f14 0% 50%) 50%/12px 12px'

const IconUpload = svg(<><path d="M12 16V4" /><path d="m7 9 5-5 5 5" /><path d="M4 20h16" /></>)
const IconSearch = svg(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>)
const IconCheck = svg(<polyline points="20 6 9 17 4 12" />)

// Refine: chispa. Sustituye al emoji ✦ para que los controles nuevos usen el
// mismo set SVG 14px que el resto de iconos del panel.
const IconSparkle = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.8 2.8M14.9 14.9l2.8 2.8M17.7 6.3l-2.8 2.8M9.1 14.9l-2.8 2.8" />
  </svg>
)
const IconHidden = svg(<><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" opacity="0.4" /><line x1="3" y1="3" x2="21" y2="21" /></>)

const styles = {
  panel: { width: 280, flexShrink: 0, borderLeft: '1px solid #1f2937', display: 'flex', flexDirection: 'column', background: '#111318' },
  empty: { padding: 16, fontSize: 12, color: '#6b7280', lineHeight: 1.5 },
  scroll: { overflowY: 'auto', flex: 1 },
  section: { padding: '10px 12px', borderBottom: '1px solid #1a1d24' },
  sectionTitle: { fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: '#6b7280', marginBottom: 8 },
  row: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 },
  rowLabel: { width: 58, flexShrink: 0, fontSize: 12, color: '#9ca3af' },
  input: { width: '100%', padding: '6px 8px', fontSize: 12, color: '#e5e7eb', background: '#0d0f14', border: '1px solid #262b36', borderRadius: 6, outline: 'none' },
  select: { width: '100%', padding: '5px 6px', fontSize: 12, color: '#e5e7eb', background: '#0d0f14', border: '1px solid #262b36', borderRadius: 6, outline: 'none' },
  color: { width: 40, height: 28, padding: 0, background: 'transparent', border: '1px solid #262b36', borderRadius: 6 },
  segmented: { display: 'flex', gap: 2, background: '#0d0f14', border: '1px solid #262b36', borderRadius: 6, padding: 2 },
  seg: { flex: 1, fontSize: 11, color: '#9ca3af', background: 'transparent', border: 'none', borderRadius: 4, padding: '4px 2px', cursor: 'pointer' },
  segActive: { background: '#3730a3', color: '#fff' },
  iconBtn: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 20, color: '#a78bfa', background: 'transparent', border: '1px solid #262b36', borderRadius: 5, cursor: 'pointer' },
  primary: { width: '100%', marginTop: 6, padding: '8px', fontSize: 12, fontWeight: 600, color: '#fff', background: '#6d28d9', border: 'none', borderRadius: 6, cursor: 'pointer' },
  ghost: { padding: '8px', fontSize: 12, fontWeight: 600, color: '#c4b5fd', background: '#1a1d24', border: '1px solid #312e81', borderRadius: 6, cursor: 'pointer' },
  robot: { width: '100%', padding: '8px', fontSize: 12, fontWeight: 600, color: '#fff', background: 'linear-gradient(90deg,#6d28d9,#4f46e5)', border: 'none', borderRadius: 6, cursor: 'pointer' },
  chips: { display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 },
  chip: { fontSize: 11, color: '#cbd5e1', background: '#1a1d24', border: '1px solid #262b36', borderRadius: 6, padding: '2px 6px', cursor: 'pointer' },
  keyBadge: { fontSize: 9, lineHeight: 1.4, color: '#6ee7b7', background: 'rgba(110,231,183,.12)', border: '1px solid rgba(110,231,183,.25)', borderRadius: 4, padding: '0 4px' },
  menu: { position: 'absolute', top: 34, left: 0, right: 0, zIndex: 20, padding: 4, background: '#161922', border: '1px solid #2a2f3a', borderRadius: 8, boxShadow: '0 12px 40px rgba(0,0,0,.5)', maxHeight: 200, overflowY: 'auto' },
  menuItem: { display: 'block', width: '100%', textAlign: 'left', padding: '6px 8px', fontSize: 12, color: '#e5e7eb', background: 'transparent', border: 'none', borderRadius: 4, cursor: 'pointer' },
} as const
