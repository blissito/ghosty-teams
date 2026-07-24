// Left panel: the layers pyramid (artboards → node tree). Clicking a layer
// selects it AND centers the camera on it — for nodes we measure the real
// rendered element (by data-id), convert screen→world, then centerOnRect.

import type { RefObject } from 'react'
import type { Artboard, Node } from './model'
import type { EditorState, EditorStore } from './store'

export function LayersTree({
  store,
  state,
  viewportRef,
}: {
  store: EditorStore
  state: EditorState
  viewportRef: RefObject<HTMLDivElement | null>
}) {
  function centerOnNode(id: string, additive: boolean) {
    if (additive) {
      store.toggleSelect(id)
      return
    }
    store.select(id)
    const vp = viewportRef.current
    if (!vp) return
    const el = vp.querySelector(`[data-id="${cssEscape(id)}"]`) as HTMLElement | null
    if (!el) return
    const vr = vp.getBoundingClientRect()
    const er = el.getBoundingClientRect()
    const cam = store.getSnapshot().camera
    const world = {
      x: (er.left - vr.left - cam.x) / cam.z,
      y: (er.top - vr.top - cam.y) / cam.z,
      w: er.width / cam.z,
      h: er.height / cam.z,
    }
    store.centerOnRect(world, { w: vr.width, h: vr.height })
  }
  function centerOnArtboard(ab: Artboard) {
    const vp = viewportRef.current
    if (!vp) return
    const vr = vp.getBoundingClientRect()
    store.centerOnRect({ x: ab.x, y: ab.y, w: ab.w, h: ab.h }, { w: vr.width, h: vr.height })
  }

  return (
    <div style={styles.panel}>
      <div style={styles.header}>Capas</div>
      <div style={styles.scroll}>
        {state.doc.artboards.map((ab) => (
          <div key={ab.id}>
            <button style={styles.artboardRow} onClick={() => centerOnArtboard(ab)}>
              ▦ {ab.name}
            </button>
            {ab.nodes.map((nd) => (
              <NodeRow key={nd.id} node={nd} depth={1} selection={state.selectionSet} onPick={centerOnNode} store={store} />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

function NodeRow({
  node,
  depth,
  selection,
  onPick,
  store,
}: {
  node: Node
  depth: number
  selection: string[]
  onPick: (id: string, additive: boolean) => void
  store: EditorStore
}) {
  const selected = selection.includes(node.id)
  const label = node.text ? `${node.tag} · ${node.text.slice(0, 18)}` : node.tag
  return (
    <>
      <div style={{ ...styles.rowWrap, background: selected ? '#3730a3' : 'transparent', opacity: node.hidden ? 0.45 : 1 }}>
        <button
          onClick={(e) => onPick(node.id, e.metaKey || e.ctrlKey || e.shiftKey)}
          style={{ ...styles.nodeRow, paddingLeft: 8 + depth * 14, color: selected ? '#fff' : '#cbd5e1' }}
        >
          <span style={styles.tag}>{glyph(node.tag)}</span>
          {label}
        </button>
        <button title={node.hidden ? 'Mostrar' : 'Ocultar'} style={styles.rowIcon} onClick={() => store.toggleHidden(node.id)}>
          {node.hidden ? '🚫' : '👁'}
        </button>
        <button title={node.locked ? 'Desbloquear' : 'Bloquear'} style={styles.rowIcon} onClick={() => store.toggleLocked(node.id)}>
          {node.locked ? '🔒' : '🔓'}
        </button>
      </div>
      {node.children.map((c) => (
        <NodeRow key={c.id} node={c} depth={depth + 1} selection={selection} onPick={onPick} store={store} />
      ))}
    </>
  )
}

function glyph(tag: string): string {
  if (/^h[1-6]$/.test(tag) || tag === 'p' || tag === 'span') return 'T'
  if (tag === 'img') return '▣'
  if (tag === 'button' || tag === 'a') return '⬒'
  return '▢'
}

function cssEscape(s: string): string {
  // minimal escape for querySelector; ids are alnum + _ so this is mostly a no-op
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s)
  return s.replace(/["\\]/g, '\\$&')
}

const styles = {
  panel: { width: 220, flexShrink: 0, borderRight: '1px solid #1f2937', display: 'flex', flexDirection: 'column', background: '#111318' },
  header: { padding: '10px 12px', fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: '#6b7280' },
  scroll: { overflowY: 'auto', flex: 1, paddingBottom: 12 },
  artboardRow: { display: 'block', width: '100%', textAlign: 'left', padding: '6px 12px', background: 'transparent', border: 'none', color: '#e5e7eb', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  rowWrap: { display: 'flex', alignItems: 'center' },
  nodeRow: { display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, textAlign: 'left', padding: '4px 8px', border: 'none', background: 'transparent', fontSize: 12, cursor: 'pointer', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' },
  rowIcon: { flexShrink: 0, width: 22, padding: '2px 0', fontSize: 10, background: 'transparent', border: 'none', cursor: 'pointer', opacity: 0.7 },
  tag: { display: 'inline-flex', width: 14, justifyContent: 'center', fontFamily: 'monospace', fontSize: 10, color: '#8b5cf6' },
} as const
