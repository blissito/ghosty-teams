// Root editor. DOM-native infinite canvas: one "world" container transformed by
// a single CSS transform (translate+scale = the camera). Pan by dragging the
// background, zoom toward the cursor with ctrl/⌘+wheel. Artboards live at world
// coordinates; off-screen artboards are culled (content not rendered).

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Doc } from './model'
import { arbitraryUtilityCss, docToHtml, nodeSubtreeToHtml, themeToCss } from './serialize'
import { EditorStore, useEditor } from './store'
import type { AgentAction, ImageProvider, RefineProvider } from './refine'
import { setHeightSizing, setWidthSizing } from './tailwindClasses'
import { NodeView } from './NodeView'
import { Toolbar } from './Toolbar'
import { LayersTree } from './LayersTree'
import { Inspector } from './Inspector'
import { ReorderController } from './reorder'

const CHROME_CSS = `
.ce-root, .ce-root * { box-sizing: border-box; }
.ce-root ::-webkit-scrollbar { width: 8px; height: 8px; }
.ce-root ::-webkit-scrollbar-track { background: transparent; }
.ce-root ::-webkit-scrollbar-thumb { background: rgba(148,163,184,.18); border-radius: 999px; border: 2px solid transparent; background-clip: content-box; }
.ce-root ::-webkit-scrollbar-thumb:hover { background: rgba(148,163,184,.38); background-clip: content-box; }
.ce-root ::-webkit-scrollbar-corner { background: transparent; }
.ce-root [class] { scrollbar-width: thin; scrollbar-color: rgba(148,163,184,.22) transparent; }
.ce-selected { outline: 2px solid #7c3aed !important; outline-offset: 1px; }
@keyframes ce-spin { to { transform: rotate(360deg); } }
.ce-spinner { display: inline-block; width: 13px; height: 13px; border: 2px solid rgba(255,255,255,.35); border-top-color: #fff; border-radius: 50%; animation: ce-spin .6s linear infinite; vertical-align: -2px; }
@keyframes ce-shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
.ce-refining { position: relative; }
.ce-refining::after { content: ''; position: absolute; inset: 0; pointer-events: none; border-radius: inherit;
  background: linear-gradient(100deg, transparent 20%, rgba(139,92,246,.18) 50%, transparent 80%); background-size: 200% 100%;
  animation: ce-shimmer 1.1s linear infinite; }
.ce-viewport { position: relative; flex: 1; overflow: hidden; background: #0f0f12;
  background-image: radial-gradient(circle, #2a2a30 1px, transparent 1px); background-size: 22px 22px; }
.ce-world { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
.ce-artboard { position: absolute; overflow: hidden; background: #fff;
  box-shadow: 0 8px 40px rgba(0,0,0,.35); }
.ce-artboard-label { position: absolute; top: -22px; left: 0; font: 12px ui-sans-serif, system-ui;
  color: #9ca3af; white-space: nowrap; }
.ce-xray [data-id] { outline: 1px solid rgba(124,58,237,.35); }
.ce-xray [data-id]::after { content: attr(data-tag); position: absolute; font: 9px monospace;
  background: #7c3aed; color: #fff; padding: 0 3px; transform: translateY(-100%); opacity: .8; }
`

export interface CanvasEditorProps {
  doc: Doc
  onChange?: (doc: Doc) => void
  refineProvider?: RefineProvider
  /** Image sourcing (replace/generate/search) for the Image panel — like easybits. */
  imageProvider?: ImageProvider
  /** Quick agent action on a node (the robot button). In Teams this hands the node
   *  to the chat agent; if omitted and a refineProvider exists, the inline box is used. */
  onAgentAction?: AgentAction
  /** Fires when selection changes (host forwards to the agent as "current selection"). */
  onSelectionChange?: (id: string | null) => void
  /** Persist the current doc. When provided, a Save button appears in the toolbar. */
  onSave?: (doc: Doc) => Promise<void> | void
  /** Provide an existing store to share state with the host (optional). */
  store?: EditorStore
}

export function CanvasEditor({ doc, onChange, refineProvider, imageProvider, onAgentAction, onSelectionChange, onSave, store: externalStore }: CanvasEditorProps) {
  const store = useMemo(() => externalStore ?? new EditorStore(doc, onChange), [externalStore])
  const state = useEditor(store)
  const viewportRef = useRef<HTMLDivElement | null>(null)

  // publish selection changes to the host (→ chat agent context)
  useEffect(() => {
    if (onSelectionChange) store.onSelectionChange = (id) => onSelectionChange(id)
  }, [store, onSelectionChange])

  // wheel: ctrl/⌘ = zoom toward cursor; otherwise pan (trackpad)
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      if (e.ctrlKey || e.metaKey) {
        store.zoomAt(cx, cy, Math.pow(1.0015, -e.deltaY))
      } else {
        store.panBy(-e.deltaX, -e.deltaY)
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [store])

  // keep the store's viewport size current; restore the saved camera per doc, else fit once
  const didInit = useRef(false)
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    store.measureViewport = () => ({ w: el.clientWidth, h: el.clientHeight })
    const report = () => store.setViewport(el.clientWidth, el.clientHeight)
    report()
    // fit once on first mount only when there's no persisted camera to restore
    if (!didInit.current && el.clientWidth > 0 && el.clientHeight > 0) {
      didInit.current = true
      if (!store.restoredCamera) store.fitAll()
    }
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [store])

  // autolayout drag-reorder controller
  const reorder = useMemo(() => new ReorderController(store, () => viewportRef.current), [store])

  // keyboard: duplicate / group / undo / redo / delete
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return
      const mod = e.metaKey || e.ctrlKey
      const sel = store.getSnapshot().selection
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        e.shiftKey ? store.redo() : store.undo()
      } else if (mod && e.key.toLowerCase() === 'd' && sel) {
        e.preventDefault()
        store.duplicateNode(sel)
      } else if (mod && e.key.toLowerCase() === 'g' && sel) {
        e.preventDefault()
        e.shiftKey ? store.ungroupNode(sel) : store.groupSelection()
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
        e.preventDefault()
        store.deleteNode(sel)
      } else if (e.key === 'ArrowUp' && sel) {
        e.preventDefault()
        store.reorderSibling(sel, -1)
      } else if (e.key === 'ArrowDown' && sel) {
        e.preventDefault()
        store.reorderSibling(sel, 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [store])

  // drag to pan (hand tool / middle mouse) + marquee-select (select tool on bg)
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const marquee = useRef<{ x0: number; y0: number } | null>(null)
  const [marqueeRect, setMarqueeRect] = useState<{ left: number; top: number; w: number; h: number } | null>(null)
  const onPointerDown = useCallback(
    (e: { button: number; clientX: number; clientY: number; currentTarget: Element; target: EventTarget | null; pointerId: number; altKey: boolean; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => {
      const onBackground = e.target === e.currentTarget
      const idEl = (e.target as Element | null)?.closest?.('[data-id]') as Element | null
      // press on a node with the select tool → select (Cmd/Shift = add to selection)
      // + arm a reorder drag (Alt/Option held = clone on drop)
      if (state.tool === 'select' && idEl && !onBackground) {
        const id = idEl.getAttribute('data-id')!
        if (e.metaKey || e.ctrlKey || e.shiftKey) {
          store.toggleSelect(id)
        } else {
          if (!store.getSnapshot().selectionSet.includes(id)) store.select(id)
          reorder.arm(id, e.clientX, e.clientY, e.altKey)
        }
        e.currentTarget.setPointerCapture?.(e.pointerId)
        return
      }
      if (state.tool === 'hand' || e.button === 1) {
        drag.current = { x: e.clientX, y: e.clientY, moved: false }
        e.currentTarget.setPointerCapture?.(e.pointerId)
      } else if (onBackground && e.button === 0) {
        // select tool on empty canvas → marquee-select
        marquee.current = { x0: e.clientX, y0: e.clientY }
        e.currentTarget.setPointerCapture?.(e.pointerId)
      }
    },
    [state.tool, reorder],
  )
  const onPointerMove = useCallback(
    (e: { clientX: number; clientY: number }) => {
      if (reorder.isArmed()) {
        if (reorder.move(e.clientX, e.clientY)) return
      }
      if (marquee.current) {
        const vp = viewportRef.current
        if (!vp) return
        const vr = vp.getBoundingClientRect()
        const { x0, y0 } = marquee.current
        setMarqueeRect({
          left: Math.min(x0, e.clientX) - vr.left,
          top: Math.min(y0, e.clientY) - vr.top,
          w: Math.abs(e.clientX - x0),
          h: Math.abs(e.clientY - y0),
        })
        return
      }
      if (!drag.current) return
      const dx = e.clientX - drag.current.x
      const dy = e.clientY - drag.current.y
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.current.moved = true
      drag.current.x = e.clientX
      drag.current.y = e.clientY
      store.panBy(dx, dy)
    },
    [store, reorder],
  )
  const onPointerUp = useCallback(
    (e: { target: EventTarget | null; currentTarget: EventTarget | null; clientX: number; clientY: number }) => {
      if (reorder.isArmed()) {
        const wasActive = reorder.active
        reorder.drop()
        if (wasActive) return
      }
      if (marquee.current) {
        const started = marquee.current
        marquee.current = null
        const rect = marqueeRect
        setMarqueeRect(null)
        const vp = viewportRef.current
        if (rect && vp && rect.w + rect.h > 6) {
          const vr = vp.getBoundingClientRect()
          const mx0 = rect.left + vr.left
          const my0 = rect.top + vr.top
          const mx1 = mx0 + rect.w
          const my1 = my0 + rect.h
          const intersects = (el: Element) => {
            const r = el.getBoundingClientRect()
            return r.right >= mx0 && r.left <= mx1 && r.bottom >= my0 && r.top <= my1
          }
          // pick the OUTERMOST intersecting nodes (skip a node if its data-id ancestor also intersects)
          const chosen = (Array.from(vp.querySelectorAll('[data-id]')) as HTMLElement[])
            .filter((el) => {
              if (!intersects(el)) return false
              const anc = el.parentElement?.closest('[data-id]')
              return !anc || !intersects(anc)
            })
            .map((el) => el.getAttribute('data-id')!)
          store.selectMany(chosen)
          return
        }
        // a click (no drag) on background → deselect
        if (started) store.select(null)
        return
      }
      const wasDrag = drag.current
      drag.current = null
      // click on empty background (no pan) → deselect
      if (wasDrag && !wasDrag.moved && e.target === e.currentTarget) store.select(null)
    },
    [store, reorder, marqueeRect],
  )

  // camera transform
  const { camera } = state
  const worldStyle = {
    transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.z})`,
  } as const

  // artboard-level culling: only render content of artboards intersecting the viewport
  const visibleIds = useMemo(() => {
    const el = viewportRef.current
    const vw = el?.clientWidth ?? 1200
    const vh = el?.clientHeight ?? 800
    const margin = 400
    const ids = new Set<string>()
    for (const ab of state.doc.artboards) {
      const sx = ab.x * camera.z + camera.x
      const sy = ab.y * camera.z + camera.y
      const sw = ab.w * camera.z
      const sh = ab.h * camera.z
      if (sx + sw > -margin && sx < vw + margin && sy + sh > -margin && sy < vh + margin) ids.add(ab.id)
    }
    return ids
  }, [state.doc.artboards, camera])

  // measure every selected node (screen coords) → Figma-style boxes (primary gets handles)
  type Box = { id: string; left: number; top: number; w: number; h: number }
  const [selBoxes, setSelBoxes] = useState<Box[]>([])
  useLayoutEffect(() => {
    const vp = viewportRef.current
    if (!vp || !state.selectionSet.length || state.mode === 'preview') {
      setSelBoxes([])
      return
    }
    const vr = vp.getBoundingClientRect()
    const boxes: Box[] = []
    for (const id of state.selectionSet) {
      const el = vp.querySelector(`[data-id="${ceEscape(id)}"]`) as HTMLElement | null
      if (!el) continue
      const er = el.getBoundingClientRect()
      boxes.push({ id, left: er.left - vr.left, top: er.top - vr.top, w: er.width, h: er.height })
    }
    setSelBoxes(boxes)
  }, [state.selectionSet, state.selection, camera, state.doc, state.mode, state.xray])
  const selBox = selBoxes.find((b) => b.id === state.selection) ?? null

  // resize via selection handles → writes w-[Npx]/h-[Npx] (real, thanks to the mini-JIT)
  const startResize = useCallback(
    (handle: [number, number], e: React.PointerEvent) => {
      e.stopPropagation()
      e.preventDefault()
      const id = state.selection
      if (!id || !selBox) return
      const node = store.findNodePublic(id)
      if (!node) return
      const [hx, hy] = handle
      const before = store.beginTransient()
      const startX = e.clientX
      const startY = e.clientY
      const startW = selBox.w
      const startH = selBox.h
      const z = store.getSnapshot().camera.z
      const move = (ev: PointerEvent) => {
        let cls = node.cls
        if (hx !== 0.5) {
          const wScreen = hx === 1 ? startW + (ev.clientX - startX) : startW - (ev.clientX - startX)
          cls = setWidthSizing(cls, 'fixed', Math.max(8, Math.round(wScreen / z)))
        }
        if (hy !== 0.5) {
          const hScreen = hy === 1 ? startH + (ev.clientY - startY) : startH - (ev.clientY - startY)
          cls = setHeightSizing(cls, 'fixed', Math.max(8, Math.round(hScreen / z)))
        }
        store.previewNodeClasses(id, cls)
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        store.commitTransient(before)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [store, state.selection, selBox],
  )

  // robot quick-action → hand the node to the chat agent (Teams) or fall back inline
  const handleRobot = useCallback(() => {
    const id = state.selection
    if (!id) return
    const node = store.findNodePublic(id)
    if (!node) return
    if (onAgentAction) onAgentAction({ nodeId: id, nodeHtml: nodeSubtreeToHtml(node) })
  }, [store, state.selection, onAgentAction])

  const themeStyle = themeToCss(state.doc.theme, { scope: '.ce-artboard' })
  const jitStyle = arbitraryUtilityCss(state.doc, '.ce-artboard')

  if (state.mode === 'preview') {
    return (
      <div className="ce-root" style={styles.root}>
        <style>{CHROME_CSS}</style>
        <Toolbar store={store} state={state} refineProvider={refineProvider} onSave={onSave} />
        <PreviewPane doc={state.doc} />
      </div>
    )
  }

  return (
    <div className="ce-root" style={styles.root}>
      <style>{CHROME_CSS}</style>
      <style>{themeStyle}</style>
      <style>{jitStyle}</style>
      <Toolbar store={store} state={state} refineProvider={refineProvider} onSave={onSave} />
      <div style={styles.body}>
        {state.panels && <LayersTree store={store} state={state} viewportRef={viewportRef} />}
        <div
          ref={viewportRef}
          className={'ce-viewport' + (state.xray ? ' ce-xray' : '')}
          style={{ cursor: state.tool === 'hand' ? 'grab' : 'default' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <div className="ce-world" style={worldStyle}>
            {state.doc.artboards.map((ab) => (
              <div
                key={ab.id}
                className={'ce-artboard ' + (ab.cls ?? '')}
                data-artboard-id={ab.id}
                style={{ left: ab.x, top: ab.y, width: ab.w, minHeight: ab.h }}
              >
                <span className="ce-artboard-label">
                  {ab.name} · {ab.w}×{ab.h}
                </span>
                {visibleIds.has(ab.id)
                  ? ab.nodes.map((nd) => (
                      <NodeView key={nd.id} node={nd} selection={state.selectionSet} onSelect={(id) => store.select(id)} interactive={state.tool === 'select'} />
                    ))
                  : null}
              </div>
            ))}
          </div>
          {state.tool === 'select' && selBoxes.length === 1 && selBox && (
            <SelectionOverlay box={selBox} onResizeStart={startResize} onRobot={onAgentAction ? handleRobot : undefined} />
          )}
          {state.tool === 'select' && selBoxes.length > 1 && (
            <>
              {selBoxes.map((b) => (
                <div key={b.id} style={{ position: 'absolute', left: b.left, top: b.top, width: b.w, height: b.h, border: '1.5px solid rgba(139,92,246,.7)', pointerEvents: 'none', zIndex: 49 }} />
              ))}
              <SelectionOverlay box={unionBox(selBoxes)} onRobot={onAgentAction ? handleRobot : undefined} dashed />
            </>
          )}
          {marqueeRect && (
            <div style={{ position: 'absolute', left: marqueeRect.left, top: marqueeRect.top, width: marqueeRect.w, height: marqueeRect.h, background: 'rgba(124,58,237,.12)', border: '1px solid #8b5cf6', pointerEvents: 'none', zIndex: 60 }} />
          )}
        </div>
        {state.panels && <Inspector store={store} state={state} refineProvider={refineProvider} imageProvider={imageProvider} onAgentAction={onAgentAction} />}
      </div>
    </div>
  )
}

const HANDLES: [number, number][] = [
  [0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5],
]
function cursorFor(hx: number, hy: number): string {
  if (hx === 0.5) return 'ns-resize'
  if (hy === 0.5) return 'ew-resize'
  return (hx === hy ? 'nwse-resize' : 'nesw-resize')
}

function unionBox(boxes: { left: number; top: number; w: number; h: number }[]) {
  const left = Math.min(...boxes.map((b) => b.left))
  const top = Math.min(...boxes.map((b) => b.top))
  const right = Math.max(...boxes.map((b) => b.left + b.w))
  const bottom = Math.max(...boxes.map((b) => b.top + b.h))
  return { left, top, w: right - left, h: bottom - top }
}

function SelectionOverlay({
  box,
  onResizeStart,
  onRobot,
  dashed,
}: {
  box: { left: number; top: number; w: number; h: number }
  onResizeStart?: (handle: [number, number], e: React.PointerEvent) => void
  onRobot?: () => void
  dashed?: boolean
}) {
  return (
    <div style={{ position: 'absolute', left: box.left, top: box.top, width: box.w, height: box.h, border: dashed ? '1.5px dashed #8b5cf6' : '1.5px solid #8b5cf6', pointerEvents: 'none', zIndex: 50, boxShadow: dashed ? 'none' : '0 0 0 1px rgba(139,92,246,.25)' }}>
      {onRobot && (
        <button
          title="Preguntar al agente"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onRobot}
          style={{ position: 'absolute', top: -2, left: '100%', marginLeft: 6, transform: 'translateY(-2px)', width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'auto', background: '#6d28d9', color: '#fff', border: '1px solid #7c3aed', borderRadius: 7, cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,.4)', fontSize: 13 }}
        >
          🤖
        </button>
      )}
      {onResizeStart && HANDLES.map(([hx, hy], i) => (
        <span
          key={i}
          onPointerDown={(e) => onResizeStart([hx, hy], e)}
          style={{
            position: 'absolute',
            left: `calc(${hx * 100}% - 5px)`,
            top: `calc(${hy * 100}% - 5px)`,
            width: 10,
            height: 10,
            background: '#fff',
            border: '1.5px solid #8b5cf6',
            borderRadius: 2,
            boxShadow: '0 1px 2px rgba(0,0,0,.4)',
            pointerEvents: 'auto',
            cursor: cursorFor(hx, hy),
          }}
        />
      ))}
    </div>
  )
}

// Preview with a real device-size switcher (Desktop/Tablet/Mobile/Full).
function PreviewPane({ doc }: { doc: Doc }) {
  const [device, setDevice] = useState<'full' | 'desktop' | 'tablet' | 'mobile'>('full')
  const widths = { full: '100%', desktop: 1440, tablet: 768, mobile: 375 } as const
  const w = widths[device]
  const html = useMemo(() => docToHtml(doc), [doc])
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 4, justifyContent: 'center', padding: 6, borderBottom: '1px solid #1f2937', background: '#111318' }}>
        {(['full', 'desktop', 'tablet', 'mobile'] as const).map((d) => (
          <button
            key={d}
            onClick={() => setDevice(d)}
            style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, cursor: 'pointer', border: '1px solid #262b36', color: d === device ? '#fff' : '#9ca3af', background: d === device ? '#3730a3' : '#1a1d24' }}
          >
            {d === 'full' ? 'Full' : d === 'desktop' ? 'Desktop' : d === 'tablet' ? 'Tablet' : 'Mobile'}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, overflow: 'auto', display: 'flex', justifyContent: 'center', background: '#1b1b20', padding: device === 'full' ? 0 : 16 }}>
        <iframe title="preview" srcDoc={html} style={{ width: w, maxWidth: '100%', height: '100%', minHeight: 400, border: device === 'full' ? 'none' : '1px solid #2a2f3a', borderRadius: device === 'full' ? 0 : 8, background: '#fff' }} sandbox="allow-scripts allow-forms allow-popups" />
      </div>
    </div>
  )
}

function ceEscape(s: string): string {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s)
  return s.replace(/["\\]/g, '\\$&')
}

const styles = {
  root: { display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: '#0f0f12', color: '#e5e7eb', fontFamily: 'ui-sans-serif, system-ui, sans-serif' },
  body: { display: 'flex', flex: 1, minHeight: 0 },
  previewFrame: { flex: 1, width: '100%', border: 'none', background: '#fff' },
} as const
