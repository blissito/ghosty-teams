// Top toolbar: tools (select/hand), add frame (presets), add block, x-ray,
// zoom controls, and the ▶ Edit/Preview toggle.

import { useState } from 'react'
import { ARTBOARD_PRESETS, type Doc, makeArtboard } from './model'
import { docToHtml } from './serialize'
import { BLOCKS } from './blocks'
import type { EditorState, EditorStore } from './store'
import type { RefineProvider } from './refine'

export function Toolbar({
  store,
  state,
  onSave,
}: {
  store: EditorStore
  state: EditorState
  refineProvider?: RefineProvider
  onSave?: (doc: Doc) => Promise<void> | void
}) {
  const [menu, setMenu] = useState<null | 'frame' | 'block'>(null)
  const [copied, setCopied] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)

  async function save() {
    if (!onSave) return
    store.setSaving(true)
    try {
      await onSave(store.getSnapshot().doc)
      store.markSaved()
    } finally {
      store.setSaving(false)
    }
  }
  async function copyCode() {
    try {
      await navigator.clipboard.writeText(docToHtml(store.getSnapshot().doc))
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* clipboard blocked */
    }
  }

  function addFrame(preset: (typeof ARTBOARD_PRESETS)[number]) {
    const abs = state.doc.artboards
    const right = abs.reduce((m, a) => Math.max(m, a.x + a.w), 0)
    store.addArtboard(makeArtboard({ name: preset.label, w: preset.w, h: preset.h, x: abs.length ? right + 80 : 0, y: 0 }))
    setMenu(null)
  }

  function addBlock(make: () => ReturnType<(typeof BLOCKS)[number]['make']>) {
    // add to the artboard containing the selection, else the first artboard
    const target =
      state.doc.artboards.find((ab) => ab.nodes.some((n) => n.id === state.selection)) ?? state.doc.artboards[0]
    if (!target) return
    store.addNode(target.id, null, make())
    setMenu(null)
  }

  const isPreview = state.mode === 'preview'

  return (
    <div style={styles.bar}>
      <div style={styles.group}>
        <TBtn active={!state.panels} onClick={() => store.togglePanels()} title="Ocultar/mostrar paneles">
          ▢
        </TBtn>
        <TBtn active={state.tool === 'select'} onClick={() => store.setTool('select')} title="Select">
          ⌖
        </TBtn>
        <TBtn active={state.tool === 'hand'} onClick={() => store.setTool('hand')} title="Pan">
          ✋
        </TBtn>
      </div>

      <div style={styles.group}>
        <div style={{ position: 'relative' }}>
          <TBtn onClick={() => setMenu(menu === 'frame' ? null : 'frame')} title="Add frame">
            ＋ Frame
          </TBtn>
          {menu === 'frame' && (
            <div style={styles.menu}>
              {ARTBOARD_PRESETS.map((p) => (
                <button key={p.key} style={styles.menuItem} onClick={() => addFrame(p)}>
                  {p.label} <span style={styles.dim}>{p.w}×{p.h}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div style={{ position: 'relative' }}>
          <TBtn onClick={() => setMenu(menu === 'block' ? null : 'block')} title="Add block">
            ＋ Block
          </TBtn>
          {menu === 'block' && (
            <div style={styles.menu}>
              {BLOCKS.map((b) => (
                <button key={b.key} style={styles.menuItem} onClick={() => addBlock(b.make)}>
                  {b.label} <span style={styles.dim}>{b.category}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <TBtn active={state.xray} onClick={() => store.toggleXray()} title="X-ray (reveal tags)">
          ⧉ Rayos-X
        </TBtn>
      </div>

      <div style={{ flex: 1 }} />

      <div style={styles.group}>
        <TBtn onClick={() => store.undo()} title="Undo">↶</TBtn>
        <TBtn onClick={() => store.redo()} title="Redo">↷</TBtn>
      </div>

      <div style={styles.group}>
        <TBtn onClick={() => store.zoomCenter(1 / 1.2)} title="Zoom out">−</TBtn>
        <span style={styles.zoom}>{Math.round(state.camera.z * 100)}%</span>
        <TBtn onClick={() => store.zoomCenter(1.2)} title="Zoom in">＋</TBtn>
        <TBtn onClick={() => store.fitAll()} title="Fit">Fit</TBtn>
      </div>

      {exportOpen && (
        <div style={styles.overlay} onClick={() => setExportOpen(false)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHead}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#f3f4f6' }}>Exportar código</div>
                <div style={{ fontSize: 12, color: '#9ca3af' }}>HTML + Tailwind de tu diseño</div>
              </div>
              <button style={styles.btn} onClick={() => setExportOpen(false)}>✕</button>
            </div>
            <pre style={styles.code}>{docToHtml(store.getSnapshot().doc)}</pre>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
              <button style={{ ...styles.btn, ...styles.btnActive }} onClick={copyCode}>{copied ? '✓ Copiado' : '⧉ Copiar código'}</button>
            </div>
          </div>
        </div>
      )}
      <div style={styles.group}>
        <TBtn onClick={() => setExportOpen(true)} title="Exportar HTML + Tailwind">{'⟨/⟩ Export'}</TBtn>
        {onSave && (
          <>
            <span style={{ ...styles.dot, background: state.dirty ? '#f59e0b' : '#22c55e' }} title={state.dirty ? 'Sin guardar' : 'Guardado'} />
            <TBtn onClick={save} title="Guardar">{state.saving ? 'Guardando…' : state.dirty ? 'Guardar' : 'Guardado'}</TBtn>
          </>
        )}
      </div>

      <TBtn active={isPreview} onClick={() => store.setMode(isPreview ? 'edit' : 'preview')} title="Preview">
        {isPreview ? '✎ Editar' : '▶ Preview'}
      </TBtn>
    </div>
  )
}

function TBtn({ children, onClick, active, title }: { children: React.ReactNode; onClick: () => void; active?: boolean; title?: string }) {
  return (
    <button title={title} onClick={onClick} style={{ ...styles.btn, ...(active ? styles.btnActive : null) }}>
      {children}
    </button>
  )
}

const styles = {
  bar: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid #1f2937', background: '#111318' },
  group: { display: 'flex', alignItems: 'center', gap: 4 },
  btn: { display: 'inline-flex', alignItems: 'center', gap: 4, height: 30, padding: '0 10px', fontSize: 12, color: '#cbd5e1', background: '#1a1d24', border: '1px solid #262b36', borderRadius: 8, cursor: 'pointer' },
  btnActive: { background: '#3730a3', color: '#fff', borderColor: '#4f46e5' },
  zoom: { minWidth: 44, textAlign: 'center', fontSize: 12, color: '#9ca3af' },
  dot: { width: 8, height: 8, borderRadius: 999, display: 'inline-block' },
  menu: { position: 'absolute', top: 34, left: 0, zIndex: 20, minWidth: 180, padding: 4, background: '#161922', border: '1px solid #2a2f3a', borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,.5)' },
  menuItem: { display: 'flex', justifyContent: 'space-between', gap: 10, width: '100%', textAlign: 'left', padding: '7px 10px', fontSize: 12, color: '#e5e7eb', background: 'transparent', border: 'none', borderRadius: 6, cursor: 'pointer' },
  dim: { color: '#6b7280', fontSize: 11 },
  overlay: { position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 },
  modal: { width: 'min(760px, 92vw)', maxHeight: '82vh', display: 'flex', flexDirection: 'column', background: '#0d0f14', border: '1px solid #262b36', borderRadius: 12, padding: 16, boxShadow: '0 20px 80px rgba(0,0,0,.6)' },
  modalHead: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 },
  code: { flex: 1, overflow: 'auto', margin: 0, padding: 12, fontSize: 12, lineHeight: 1.5, fontFamily: 'monospace', color: '#c7d2fe', background: '#08090d', border: '1px solid #1f2430', borderRadius: 8, whiteSpace: 'pre', tabSize: 2 },
} as const
