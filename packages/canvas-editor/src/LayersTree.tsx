// Left panel: the layers pyramid (artboards → node tree). Click selects + centers
// the camera; per-row eye/lock toggles; and drag-and-drop to reorder / reparent
// (drop above/below a row = sibling, drop onto the middle = nest inside).

import { useState, type RefObject } from 'react'
import { findNode, locateNode, type Artboard, type Node } from './model'
import type { EditorState, EditorStore } from './store'

type DropPos = 'before' | 'after' | 'inside'
interface DropTarget {
  id: string
  pos: DropPos
}

export function LayersTree({
  store,
  state,
  viewportRef,
}: {
  store: EditorStore
  state: EditorState
  viewportRef: RefObject<HTMLDivElement | null>
}) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [drop, setDrop] = useState<DropTarget | null>(null)

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
    store.centerOnRect(
      { x: (er.left - vr.left - cam.x) / cam.z, y: (er.top - vr.top - cam.y) / cam.z, w: er.width / cam.z, h: er.height / cam.z },
      { w: vr.width, h: vr.height },
    )
  }
  function centerOnArtboard(ab: Artboard) {
    const vp = viewportRef.current
    if (!vp) return
    const vr = vp.getBoundingClientRect()
    store.centerOnRect({ x: ab.x, y: ab.y, w: ab.w, h: ab.h }, { w: vr.width, h: vr.height })
  }

  function performDrop() {
    if (!dragId || !drop || dragId === drop.id) {
      setDragId(null)
      setDrop(null)
      return
    }
    const doc = store.getSnapshot().doc
    const over = findNode(doc, drop.id)
    const loc = locateNode(doc, drop.id)
    if (over && loc) {
      if (drop.pos === 'inside') {
        store.moveNode(dragId, { artboardId: loc.artboardId, parentId: drop.id, index: over.children.length })
      } else {
        store.moveNode(dragId, { artboardId: loc.artboardId, parentId: loc.parentId, index: loc.index + (drop.pos === 'after' ? 1 : 0) })
      }
    }
    setDragId(null)
    setDrop(null)
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
              <NodeRow
                key={nd.id}
                node={nd}
                depth={1}
                selection={state.selectionSet}
                onPick={centerOnNode}
                store={store}
                dragId={dragId}
                drop={drop}
                onDragStartRow={setDragId}
                onDragOverRow={setDrop}
                onDropRow={performDrop}
                onDragEndRow={() => {
                  setDragId(null)
                  setDrop(null)
                }}
              />
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
  dragId,
  drop,
  onDragStartRow,
  onDragOverRow,
  onDropRow,
  onDragEndRow,
}: {
  node: Node
  depth: number
  selection: string[]
  onPick: (id: string, additive: boolean) => void
  store: EditorStore
  dragId: string | null
  drop: DropTarget | null
  onDragStartRow: (id: string) => void
  onDragOverRow: (t: DropTarget) => void
  onDropRow: () => void
  onDragEndRow: () => void
}) {
  const selected = selection.includes(node.id)
  const label = node.text ? `${node.tag} · ${node.text.slice(0, 18)}` : node.tag
  const isDrop = drop?.id === node.id
  return (
    <>
      <div
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          onDragStartRow(node.id)
        }}
        onDragOver={(e) => {
          if (!dragId || dragId === node.id) return
          e.preventDefault()
          const r = e.currentTarget.getBoundingClientRect()
          const rel = (e.clientY - r.top) / r.height
          const pos: DropPos = rel < 0.28 ? 'before' : rel > 0.72 ? 'after' : 'inside'
          onDragOverRow({ id: node.id, pos })
        }}
        onDrop={(e) => {
          e.preventDefault()
          onDropRow()
        }}
        onDragEnd={onDragEndRow}
        style={{
          ...styles.rowWrap,
          background: isDrop && drop?.pos === 'inside' ? '#4338ca' : selected ? '#3730a3' : 'transparent',
          opacity: node.hidden ? 0.45 : dragId === node.id ? 0.4 : 1,
          boxShadow:
            isDrop && drop?.pos === 'before' ? 'inset 0 2px 0 #8b5cf6' : isDrop && drop?.pos === 'after' ? 'inset 0 -2px 0 #8b5cf6' : undefined,
        }}
      >
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
        <NodeRow
          key={c.id}
          node={c}
          depth={depth + 1}
          selection={selection}
          onPick={onPick}
          store={store}
          dragId={dragId}
          drop={drop}
          onDragStartRow={onDragStartRow}
          onDragOverRow={onDragOverRow}
          onDropRow={onDropRow}
          onDragEndRow={onDragEndRow}
        />
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
