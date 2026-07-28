// Left panel: the layers pyramid (artboards → node tree). Click selects + centers
// the camera; per-row eye/lock toggles; and drag-and-drop to reorder / reparent
// (drop above/below a row = sibling, drop onto the middle = nest inside).

import { useEffect, useRef, useState, type RefObject } from 'react'
import { findNode, locateNode, type Artboard, type Node } from './model'
import { useActiveRefines } from './Inspector'
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
  // Plegado por contenedor. Un artefacto real anida svg > g > path y el árbol se
  // vuelve ilegible; plegar es lo que lo hace navegable.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  // Qué nodos están refinándose ahora: el árbol es el único sitio donde se ve
  // TODO el artefacto, así que es donde tiene sentido señalarlo — y de paso da
  // un clic para volver al nodo que se está trabajando.
  const refining = new Set(useActiveRefines().map((r) => r.nodeId))
  const toggleCollapse = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  // Seleccionar en el LIENZO un nodo que vive dentro de una rama plegada tiene
  // que abrir esa rama: si no, la fila no existe y el scroll no la puede traer.
  const sel = state.selection?.[0]
  useEffect(() => {
    if (!sel) return
    const chain: string[] = []
    for (const ab of state.doc.artboards) {
      const dig = (nodes: Node[], path: string[]): boolean =>
        nodes.some((n) => {
          if (n.id === sel) {
            chain.push(...path)
            return true
          }
          return dig(n.children, [...path, n.id])
        })
      if (dig(ab.nodes, [])) break
    }
    if (chain.length) {
      setCollapsed((prev) => {
        if (!chain.some((id) => prev.has(id))) return prev
        const next = new Set(prev)
        for (const id of chain) next.delete(id)
        return next
      })
    }
  }, [sel, state.doc])

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
                collapsed={collapsed}
                onToggleCollapse={toggleCollapse}
                refining={refining}
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
  collapsed,
  onToggleCollapse,
  refining,
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
  collapsed: Set<string>
  onToggleCollapse: (id: string) => void
  refining: Set<string>
}) {
  const selected = selection.includes(node.id)
  // Con un artefacto grande el nodo seleccionado en el lienzo caía fuera de vista
  // en el árbol. Al seleccionarlo, la fila se trae a la vista (sin saltos: 'nearest').
  const rowRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    // 'center' y no 'nearest': con 'nearest' la fila quedaba pegada al borde
    // inferior del panel — visible, pero con sus hijos fuera de cuadro, que es
    // justo lo que uno quiere ver al seleccionar un contenedor.
    if (selected) rowRef.current?.scrollIntoView?.({ block: 'center', inline: 'nearest' })
  }, [selected])
  const label = node.text ? `${node.tag} · ${node.text.slice(0, 18)}` : node.tag
  const isDrop = drop?.id === node.id
  const hasKids = node.children.length > 0
  const isCollapsed = collapsed.has(node.id)
  return (
    <>
      <div
        ref={rowRef}
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
        {/* La sangría vive aquí, no en el botón: así el chevron de cada nivel
            queda alineado con su columna y la pirámide se lee. */}
        <span style={{ paddingLeft: 4 + depth * 12, flexShrink: 0 }}>
          <button
            title={hasKids ? (isCollapsed ? 'Desplegar' : 'Plegar') : undefined}
            onClick={() => hasKids && onToggleCollapse(node.id)}
            style={{
              ...styles.caret,
              // Sin hijos no hay chevron, pero el hueco se conserva para que las
              // etiquetas no bailen de una fila a otra.
              visibility: hasKids ? 'visible' : 'hidden',
              transform: isCollapsed ? 'rotate(-90deg)' : 'none',
            }}
          >
            ▾
          </button>
        </span>
        <button
          onClick={(e) => onPick(node.id, e.metaKey || e.ctrlKey || e.shiftKey)}
          style={{ ...styles.nodeRow, color: selected ? '#fff' : '#cbd5e1' }}
        >
          <span style={styles.tag}>{refining.has(node.id) ? <span className="ce-spinner" /> : glyph(node.tag)}</span>
          {label}
        </button>
        <button title={node.hidden ? 'Mostrar' : 'Ocultar'} style={styles.rowIcon} onClick={() => store.toggleHidden(node.id)}>
          {node.hidden ? '🚫' : '👁'}
        </button>
        <button title={node.locked ? 'Desbloquear' : 'Bloquear'} style={styles.rowIcon} onClick={() => store.toggleLocked(node.id)}>
          {node.locked ? '🔒' : '🔓'}
        </button>
      </div>
      {!isCollapsed && node.children.map((c) => (
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
          collapsed={collapsed}
          onToggleCollapse={onToggleCollapse}
          refining={refining}
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
  caret: { width: 14, height: 14, lineHeight: '14px', padding: 0, fontSize: 9, color: '#6b7280', background: 'transparent', border: 'none', cursor: 'pointer', transition: 'transform .12s' },
  tag: { display: 'inline-flex', width: 14, justifyContent: 'center', fontFamily: 'monospace', fontSize: 10, color: '#8b5cf6' },
} as const
