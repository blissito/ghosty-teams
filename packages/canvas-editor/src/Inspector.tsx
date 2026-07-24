// Right panel: a structured property inspector modeled on efecto — Node (Tag,
// Content), Layout (Display), Typography (Size/Leading/Weight/Tracking/Align),
// Size & Spacing (W/H Hug/Fill/Fixed, Padding, Margin, Overflow), Colors, Radius,
// plus a collapsible </> code panel for the raw className, and a streaming Refine
// box. Controls read/write Tailwind classes via the GROUPS helpers.

import { useState } from 'react'
import { FONT_OPTIONS, PALETTE_PRESETS, activeTokens, findNode, type Node } from './model'
import { htmlToNode, nodeSubtreeToHtml } from './serialize'
import {
  GROUPS,
  addClass,
  autocomplete,
  classList,
  getDisplay,
  getHeightSizing,
  getWidthSizing,
  groupValue,
  removeClass,
  setDisplay,
  setGroup,
  setHeightSizing,
  setWidthSizing,
  toggleClass,
  type Display,
  type PropOption,
  type Sizing,
} from './tailwindClasses'
import type { EditorState, EditorStore } from './store'
import type { AgentAction, ImageProvider, RefineProvider } from './refine'

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
          <LayoutPanel store={store} node={node} />
          {(TEXT_TAGS.has(node.tag) || node.text != null) && <TypographyPanel store={store} node={node} />}
          <SizeSpacingPanel store={store} node={node} />
          <ColorsPanel store={store} node={node} />
          <EffectsPanel store={store} node={node} />
          {node.tag === 'img' && <ImagePanel store={store} node={node} imageProvider={imageProvider} />}
          <ClassChips store={store} node={node} />
          {refineProvider && <RefinePanel store={store} node={node} refineProvider={refineProvider} />}
        </div>
      )}
      <ThemePanel store={store} state={state} />
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

// --- Layout: display + (flex) align/justify/gap ---
function LayoutPanel({ store, node }: { store: EditorStore; node: Node }) {
  const display = getDisplay(node.cls)
  const isFlex = display === 'flex-row' || display === 'flex-col'
  const isGrid = display === 'grid'
  const set = (cls: string) => store.setNodeClasses(node.id, cls)
  return (
    <Section title="Layout">
      <Row label="Display">
        <Segmented<Display>
          value={display}
          options={[
            ['block', IconBlock, 'Block (flujo normal)'],
            ['flex-row', IconRow, 'Flex fila (autolayout horizontal)'],
            ['flex-col', IconCol, 'Flex columna (autolayout vertical)'],
            ['grid', IconGrid, 'Grid'],
            ['hidden', IconHidden, 'Oculto (display none)'],
          ]}
          onChange={(d) => set(setDisplay(node.cls, d))}
        />
      </Row>
      {isGrid && <PropSelect label="Columnas" cls={node.cls} group={GROUPS.gridCols} onSet={set} />}
      {isFlex && (
        <>
          <PropSelect label="Align" cls={node.cls} group={GROUPS.items} onSet={set} />
          <PropSelect label="Justify" cls={node.cls} group={GROUPS.justify} onSet={set} />
        </>
      )}
      {(isFlex || isGrid) && <PropSelect label="Gap" cls={node.cls} group={GROUPS.gap} onSet={set} />}
    </Section>
  )
}

// --- Typography ---
function TypographyPanel({ store, node }: { store: EditorStore; node: Node }) {
  const set = (cls: string) => store.setNodeClasses(node.id, cls)
  return (
    <Section title="Tipografía">
      <PropSelect label="Size" cls={node.cls} group={GROUPS.size} onSet={set} />
      <PropSelect label="Leading" cls={node.cls} group={GROUPS.leading} onSet={set} />
      <PropSelect label="Weight" cls={node.cls} group={GROUPS.weight} onSet={set} />
      <PropSelect label="Tracking" cls={node.cls} group={GROUPS.tracking} onSet={set} />
      <Row label="Align">
        <Segmented<string>
          value={groupValue(node.cls, GROUPS.align) || 'text-left'}
          options={GROUPS.align.map(([c, l]) => [c, l] as [string, string])}
          onChange={(v) => set(setGroup(node.cls, GROUPS.align, v))}
        />
      </Row>
    </Section>
  )
}

// --- Size & Spacing ---
function SizeSpacingPanel({ store, node }: { store: EditorStore; node: Node }) {
  const set = (cls: string) => store.setNodeClasses(node.id, cls)
  const sizingOpts: [Sizing, string][] = [
    ['hug', 'Hug'],
    ['fixed', 'Fixed'],
    ['fill', 'Fill'],
  ]
  return (
    <Section title="Size & Spacing">
      <Row label="W">
        <Segmented<Sizing> value={getWidthSizing(node.cls)} options={sizingOpts} onChange={(s) => set(setWidthSizing(node.cls, s))} />
      </Row>
      <Row label="H">
        <Segmented<Sizing> value={getHeightSizing(node.cls)} options={sizingOpts} onChange={(s) => set(setHeightSizing(node.cls, s))} />
      </Row>
      <PropSelect label="Padding" cls={node.cls} group={GROUPS.padding} onSet={set} />
      <PropSelect label="Margin" cls={node.cls} group={GROUPS.margin} onSet={set} />
      <PropSelect label="Overflow" cls={node.cls} group={GROUPS.overflow} onSet={set} />
    </Section>
  )
}

// --- Colors + radius ---
function ColorsPanel({ store, node }: { store: EditorStore; node: Node }) {
  const set = (cls: string) => store.setNodeClasses(node.id, cls)
  return (
    <Section title="Color">
      <PropSelect label="Text" cls={node.cls} group={GROUPS.textColor} onSet={set} />
      <PropSelect label="Fondo" cls={node.cls} group={GROUPS.bgColor} onSet={set} />
      <PropSelect label="Borde" cls={node.cls} group={GROUPS.borderWidth} onSet={set} />
      <PropSelect label="Color borde" cls={node.cls} group={GROUPS.borderColor} onSet={set} />
      <PropSelect label="Radius" cls={node.cls} group={GROUPS.radius} onSet={set} />
    </Section>
  )
}

// --- Effects: shadow + opacity ---
function EffectsPanel({ store, node }: { store: EditorStore; node: Node }) {
  const set = (cls: string) => store.setNodeClasses(node.id, cls)
  return (
    <Section title="Efectos">
      <PropSelect label="Sombra" cls={node.cls} group={GROUPS.shadow} onSet={set} />
      <PropSelect label="Opacidad" cls={node.cls} group={GROUPS.opacity} onSet={set} />
    </Section>
  )
}

function ImagePanel({ store, node, imageProvider }: { store: EditorStore; node: Node; imageProvider?: ImageProvider }) {
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState<'gen' | 'search' | null>(null)
  const [results, setResults] = useState<string[]>([])
  const setSrc = (src: string) => store.updateNode(node.id, { src })

  async function generate() {
    if (!imageProvider?.generate || !prompt.trim() || busy) return
    setBusy('gen')
    try {
      setSrc(await imageProvider.generate(prompt.trim()))
    } finally {
      setBusy(null)
    }
  }
  async function search() {
    if (!imageProvider?.search || !prompt.trim() || busy) return
    setBusy('search')
    try {
      setResults(await imageProvider.search(prompt.trim()))
    } finally {
      setBusy(null)
    }
  }
  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !imageProvider?.upload) return
    setSrc(await imageProvider.upload(file))
  }

  return (
    <Section title="Imagen">
      <Row label="src">
        <input style={styles.input} value={node.src ?? ''} onChange={(e) => setSrc(e.target.value)} />
      </Row>
      {node.src && <img src={node.src} alt="" style={{ width: '100%', borderRadius: 6, marginBottom: 6, maxHeight: 120, objectFit: 'cover' }} />}
      {imageProvider && (imageProvider.generate || imageProvider.search) && (
        <>
          <textarea style={{ ...styles.input, minHeight: 40, resize: 'vertical' }} placeholder="describe la imagen…" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            {imageProvider.generate && (
              <button style={{ ...styles.primary, marginTop: 0, flex: 1 }} disabled={!!busy} onClick={generate}>
                {busy === 'gen' ? <><span className="ce-spinner" /> Generando…</> : '✦ Generar'}
              </button>
            )}
            {imageProvider.search && (
              <button style={{ ...styles.ghost, flex: 1 }} disabled={!!busy} onClick={search}>
                {busy === 'search' ? 'Buscando…' : '🔍 Buscar'}
              </button>
            )}
          </div>
        </>
      )}
      {results.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4, marginTop: 6 }}>
          {results.map((url) => (
            <img key={url} src={url} alt="" onClick={() => setSrc(url)} style={{ width: '100%', height: 48, objectFit: 'cover', borderRadius: 4, cursor: 'pointer', border: node.src === url ? '2px solid #8b5cf6' : '1px solid #262b36' }} />
          ))}
        </div>
      )}
      {imageProvider?.upload && (
        <label style={{ ...styles.ghost, display: 'block', textAlign: 'center', marginTop: 6, cursor: 'pointer' }}>
          ⬆ Subir imagen
          <input type="file" accept="image/*" style={{ display: 'none' }} onChange={onFile} />
        </label>
      )}
    </Section>
  )
}

function RefinePanel({ store, node, refineProvider }: { store: EditorStore; node: Node; refineProvider: RefineProvider }) {
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState(false)
  async function run() {
    if (!instruction.trim() || busy) return
    setBusy(true)
    const currentHtml = nodeSubtreeToHtml(node)
    try {
      const finalHtml = await refineProvider.refineNode(
        { nodeId: node.id, instruction: instruction.trim(), currentHtml },
        { onPartial: (p) => { const parsed = htmlToNode(p, node.id); if (parsed) store.replaceNodeSubtree(node.id, parsed) } },
      )
      const parsed = htmlToNode(finalHtml, node.id)
      if (parsed) store.replaceNodeSubtree(node.id, parsed)
      setInstruction('')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section title="✦ Refinar con IA">
      <textarea style={{ ...styles.input, minHeight: 52, resize: 'vertical' }} placeholder="haz el título más grande, fondo oscuro…" value={instruction} onChange={(e) => setInstruction(e.target.value)} disabled={busy} />
      <button
        className={busy ? 'ce-refining' : undefined}
        style={{ ...styles.primary, cursor: busy ? 'progress' : 'pointer', opacity: busy ? 0.85 : 1 }}
        disabled={busy}
        onClick={run}
      >
        {busy ? (
          <>
            <span className="ce-spinner" /> Refinando…
          </>
        ) : (
          '✦ Aplicar a este nodo'
        )}
      </button>
    </Section>
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

function ThemePanel({ store, state }: { store: EditorStore; state: EditorState }) {
  const t = state.doc.theme
  const tokens = activeTokens(t)
  return (
    <Section title="Tema">
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

// --- primitives ---
function PropSelect({ label, cls, group, onSet }: { label: string; cls: string; group: PropOption[]; onSet: (cls: string) => void }) {
  const cur = groupValue(cls, group)
  return (
    <Row label={label}>
      <select style={styles.select} value={cur} onChange={(e) => onSet(setGroup(cls, group, e.target.value))}>
        <option value="">—</option>
        {group.map(([c, l]) => (
          <option key={c} value={c}>
            {l}
          </option>
        ))}
      </select>
    </Row>
  )
}

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div style={styles.section}>
      <div style={{ ...styles.sectionTitle, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>{title}</span>
        {action}
      </div>
      {children}
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
  menu: { position: 'absolute', top: 34, left: 0, right: 0, zIndex: 20, padding: 4, background: '#161922', border: '1px solid #2a2f3a', borderRadius: 8, boxShadow: '0 12px 40px rgba(0,0,0,.5)', maxHeight: 200, overflowY: 'auto' },
  menuItem: { display: 'block', width: '100%', textAlign: 'left', padding: '6px 8px', fontSize: 12, color: '#e5e7eb', background: 'transparent', border: 'none', borderRadius: 4, cursor: 'pointer' },
} as const
