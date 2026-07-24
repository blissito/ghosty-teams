// Dependency-free store (no zustand). A tiny observable + React binding via
// useSyncExternalStore. Holds camera, selection and the Doc; all Doc mutations
// are immutable and go through actions so history/undo can hook in later.

import { useSyncExternalStore } from 'react'
import type { Artboard, Doc, MoveTarget, Node, NodeId } from './model'
import { cloneNode, genId, insertNode, mapArtboard, mapNode, moveNode, replaceNode, walk } from './model'

export interface Camera {
  x: number
  y: number
  z: number
}

export interface EditorState {
  doc: Doc
  camera: Camera
  /** primary/active selection (inspector, overlay handles, refine target) */
  selection: NodeId | null
  /** all selected ids (multi-select highlight + group); includes the primary */
  selectionSet: NodeId[]
  mode: 'edit' | 'preview'
  tool: 'select' | 'hand'
  xray: boolean
  /** show the side panels (layers + inspector); false = focus mode */
  panels: boolean
  /** unsaved changes since the last markSaved() */
  dirty: boolean
  /** a save is in flight */
  saving: boolean
}

export const MIN_Z = 0.01
export const MAX_Z = 64
export const clampZoom = (z: number) => Math.max(MIN_Z, Math.min(MAX_Z, z))

type Listener = () => void

export class EditorStore {
  private state: EditorState
  private listeners = new Set<Listener>()
  private history: Doc[] = []
  private future: Doc[] = []
  private vp = { w: 1200, h: 800 }
  onChange?: (doc: Doc) => void
  /** Fires when selection changes — the host forwards this to the chat agent so it
   *  knows which node ("this") the user means when asking for an edit in Teams. */
  onSelectionChange?: (id: NodeId | null, node: Node | null) => void
  /** true if the camera was restored from persisted state (skip the initial fit). */
  restoredCamera = false

  constructor(doc: Doc, onChange?: (doc: Doc) => void) {
    const saved = loadCam(doc.id)
    this.restoredCamera = !!saved
    this.state = {
      doc,
      camera: saved ?? { x: 0, y: 0, z: 1 },
      selection: null,
      selectionSet: [],
      mode: 'edit',
      tool: 'select',
      xray: false,
      panels: true,
      dirty: false,
      saving: false,
    }
    this.onChange = onChange
  }

  // --- subscription ---
  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  getSnapshot = (): EditorState => this.state
  private emit() {
    for (const l of this.listeners) l()
  }
  private set(patch: Partial<EditorState>) {
    this.state = { ...this.state, ...patch }
    this.emit()
  }

  // --- doc mutation core (records history, notifies host) ---
  private commit(next: Doc) {
    this.history.push(this.state.doc)
    if (this.history.length > 100) this.history.shift()
    this.future = []
    this.state = { ...this.state, doc: next, dirty: true }
    this.emit()
    this.onChange?.(next)
  }

  /** Host calls this once a save has persisted the current doc. */
  markSaved() {
    this.state = { ...this.state, dirty: false, saving: false }
    this.emit()
  }
  setSaving(saving: boolean) {
    this.state = { ...this.state, saving }
    this.emit()
  }

  undo() {
    const prev = this.history.pop()
    if (!prev) return
    this.future.push(this.state.doc)
    this.state = { ...this.state, doc: prev }
    this.emit()
    this.onChange?.(prev)
  }
  redo() {
    const next = this.future.pop()
    if (!next) return
    this.history.push(this.state.doc)
    this.state = { ...this.state, doc: next }
    this.emit()
    this.onChange?.(next)
  }

  // --- camera (every change persists per doc → refresh keeps zoom + pan) ---
  private applyCamera(cam: Camera) {
    this.state = { ...this.state, camera: cam }
    saveCam(this.state.doc.id, cam)
    this.emit()
  }
  setCamera(cam: Partial<Camera>) {
    this.applyCamera({ ...this.state.camera, ...cam })
  }
  panBy(dx: number, dy: number) {
    const { x, y, z } = this.state.camera
    this.applyCamera({ x: x + dx, y: y + dy, z })
  }
  /** Zoom toward a screen-space point (cx, cy), keeping that point stationary. */
  zoomAt(cx: number, cy: number, factor: number) {
    const { x, y, z } = this.state.camera
    const nz = clampZoom(z * factor)
    // world point under cursor stays fixed: screen = world*z + pan
    const wx = (cx - x) / z
    const wy = (cy - y) / z
    this.applyCamera({ z: nz, x: cx - wx * nz, y: cy - wy * nz })
  }
  /** Host reports the current viewport size (used by centered zoom buttons / fit). */
  setViewport(w: number, h: number) {
    if (w > 0 && h > 0) this.vp = { w, h }
  }
  /** Live viewport measurer set by the editor — preferred over the cached size. */
  measureViewport?: () => { w: number; h: number }
  private viewport(): { w: number; h: number } {
    const m = this.measureViewport?.()
    return m && m.w > 0 && m.h > 0 ? m : this.vp
  }
  /** Zoom by a factor around the viewport center (for +/- buttons). */
  zoomCenter(factor: number) {
    const vp = this.viewport()
    this.zoomAt(vp.w / 2, vp.h / 2, factor)
  }
  /** Fit all artboards into the viewport. */
  fitAll(pad = 80) {
    const abs = this.state.doc.artboards
    if (!abs.length) return
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity
    for (const ab of abs) {
      minX = Math.min(minX, ab.x)
      minY = Math.min(minY, ab.y)
      maxX = Math.max(maxX, ab.x + ab.w)
      maxY = Math.max(maxY, ab.y + ab.h)
    }
    this.centerOnRect({ x: minX, y: minY, w: maxX - minX, h: maxY - minY }, this.viewport(), pad)
  }

  /** Center the camera on a world-space rect at a comfortable zoom. */
  centerOnRect(rect: { x: number; y: number; w: number; h: number }, viewport: { w: number; h: number }, pad = 80) {
    const z = clampZoom(Math.min((viewport.w - pad * 2) / rect.w, (viewport.h - pad * 2) / rect.h, 1.5))
    const x = viewport.w / 2 - (rect.x + rect.w / 2) * z
    const y = viewport.h / 2 - (rect.y + rect.h / 2) * z
    this.applyCamera({ x, y, z })
  }

  // --- ui ---
  select(id: NodeId | null) {
    this.set({ selection: id, selectionSet: id ? [id] : [] })
    const node = id ? this.findNodePublic(id) : null
    this.onSelectionChange?.(id, node)
  }
  /** Replace the selection with a set of ids (marquee-select). */
  selectMany(ids: NodeId[]) {
    const primary = ids.length ? ids[ids.length - 1] : null
    this.set({ selectionSet: ids, selection: primary })
    this.onSelectionChange?.(primary, primary ? this.findNodePublic(primary) : null)
  }
  /** Toggle an id in the multi-selection (Cmd/Shift-click). */
  toggleSelect(id: NodeId) {
    const set = this.state.selectionSet
    const next = set.includes(id) ? set.filter((x) => x !== id) : [...set, id]
    const primary = next.length ? next[next.length - 1] : null
    this.set({ selectionSet: next, selection: primary })
    this.onSelectionChange?.(primary, primary ? this.findNodePublic(primary) : null)
  }
  /** Public lookup of the selected node (host reads this to send the agent context). */
  findNodePublic(id: NodeId): Node | null {
    for (const ab of this.state.doc.artboards) {
      let found: Node | null = null
      const dig = (nodes: Node[]) => {
        for (const n of nodes) {
          if (n.id === id) found = n
          else if (n.children.length) dig(n.children)
          if (found) return
        }
      }
      dig(ab.nodes)
      if (found) return found
    }
    return null
  }
  setTool(tool: EditorState['tool']) {
    this.set({ tool })
  }
  setMode(mode: EditorState['mode']) {
    this.set({ mode })
  }
  toggleXray() {
    this.set({ xray: !this.state.xray })
  }
  togglePanels() {
    this.set({ panels: !this.state.panels })
  }

  // --- node edits ---
  updateNode(id: NodeId, patch: Partial<Node>) {
    this.commit(mapNode(this.state.doc, id, (n) => ({ ...n, ...patch })))
  }
  setNodeClasses(id: NodeId, cls: string) {
    this.updateNode(id, { cls })
  }
  setNodeText(id: NodeId, text: string) {
    this.updateNode(id, { text })
  }
  toggleHidden(id: NodeId) {
    const n = this.findNodePublic(id)
    if (n) this.updateNode(id, { hidden: !n.hidden })
  }
  toggleLocked(id: NodeId) {
    const n = this.findNodePublic(id)
    if (n) this.updateNode(id, { locked: !n.locked })
  }
  /** Move a node one slot earlier/later among its siblings (arrow-key reorder). */
  reorderSibling(id: NodeId, dir: -1 | 1) {
    const shift = (nodes: Node[]): Node[] => {
      const i = nodes.findIndex((n) => n.id === id)
      if (i >= 0) {
        const j = i + dir
        if (j < 0 || j >= nodes.length) return nodes
        const copy = nodes.slice()
        ;[copy[i], copy[j]] = [copy[j], copy[i]]
        return copy
      }
      return nodes.map((n) => (n.children.length ? { ...n, children: shift(n.children) } : n))
    }
    this.commit({ ...this.state.doc, artboards: this.state.doc.artboards.map((ab) => ({ ...ab, nodes: shift(ab.nodes) })) })
  }
  /** Replace a node's entire subtree — the target of targeted refine. */
  replaceNodeSubtree(id: NodeId, replacement: Node) {
    this.commit(replaceNode(this.state.doc, id, replacement))
  }
  deleteNode(id: NodeId) {
    const strip = (nodes: Node[]): Node[] =>
      nodes.filter((n) => n.id !== id).map((n) => ({ ...n, children: strip(n.children) }))
    const next: Doc = {
      ...this.state.doc,
      artboards: this.state.doc.artboards.map((ab) => ({ ...ab, nodes: strip(ab.nodes) })),
    }
    this.commit(next)
    if (this.state.selectionSet.includes(id)) {
      const set = this.state.selectionSet.filter((x) => x !== id)
      this.set({ selectionSet: set, selection: set.length ? set[set.length - 1] : null })
    }
  }
  /** Move a node to a new parent/index (autolayout drag-reorder). */
  moveNode(nodeId: NodeId, target: MoveTarget) {
    this.commit(moveNode(this.state.doc, nodeId, target))
  }
  /** Insert a node subtree at a target (Alt-drag clone drop). */
  insertNode(target: MoveTarget, node: Node) {
    this.commit(insertNode(this.state.doc, target, node))
    this.state = { ...this.state, selection: node.id, selectionSet: [node.id] }
    this.emit()
  }
  /** Duplicate a node as the next sibling; selects the copy. */
  duplicateNode(id: NodeId) {
    for (const ab of this.state.doc.artboards) {
      const sib = ab.nodes.findIndex((n) => n.id === id)
      if (sib >= 0) return this.insertNode({ artboardId: ab.id, parentId: null, index: sib + 1 }, cloneNode(ab.nodes[sib]))
      let done = false
      const dig = (parent: Node) => {
        if (done) return
        const i = parent.children.findIndex((n) => n.id === id)
        if (i >= 0) {
          this.insertNode({ artboardId: ab.id, parentId: parent.id, index: i + 1 }, cloneNode(parent.children[i]))
          done = true
          return
        }
        parent.children.forEach(dig)
      }
      ab.nodes.forEach(dig)
      if (done) return
    }
  }
  /** Wrap a node in a new autolayout (flex) frame; selects the frame. */
  groupNode(id: NodeId) {
    const node = this.findNodePublic(id)
    if (!node) return
    const frame: Node = { id: genId(), tag: 'div', cls: 'flex flex-col gap-4 p-4', children: [node] }
    this.commit(replaceNode(this.state.doc, id, frame))
    this.state = { ...this.state, selection: frame.id, selectionSet: [frame.id] }
    this.emit()
  }
  /** Ungroup a container: replace the frame with its children in the parent. */
  ungroupNode(id: NodeId) {
    const frame = this.findNodePublic(id)
    if (!frame || frame.children.length === 0) return
    const kids = frame.children
    const splice = (nodes: Node[]): Node[] => {
      const out: Node[] = []
      for (const n of nodes) {
        if (n.id === id) out.push(...kids)
        else out.push({ ...n, children: splice(n.children) })
      }
      return out
    }
    this.commit({ ...this.state.doc, artboards: this.state.doc.artboards.map((ab) => ({ ...ab, nodes: splice(ab.nodes) })) })
    this.set({ selection: kids[0].id, selectionSet: kids.map((k) => k.id) })
  }
  /** Group the current multi-selection (sibling nodes) into one autolayout frame. */
  groupSelection() {
    const ids = this.state.selectionSet
    if (ids.length < 2) {
      if (ids[0]) this.groupNode(ids[0])
      return
    }
    // find the sibling list (artboard root or a node's children) that holds the first id
    const doc = this.state.doc
    let ctx: { artboardId: string; parentId: NodeId | null; siblings: Node[] } | null = null
    for (const ab of doc.artboards) {
      if (ab.nodes.some((n) => n.id === ids[0])) {
        ctx = { artboardId: ab.id, parentId: null, siblings: ab.nodes }
        break
      }
      let hit: Node | null = null
      walk(ab.nodes, (n) => {
        if (!hit && n.children.some((c) => c.id === ids[0])) hit = n
      })
      if (hit) {
        ctx = { artboardId: ab.id, parentId: (hit as Node).id, siblings: (hit as Node).children }
        break
      }
    }
    if (!ctx) return
    const selected = ctx.siblings.filter((n) => ids.includes(n.id))
    if (selected.length < 2) {
      this.groupNode(ids[0])
      return
    }
    const frame: Node = { id: genId(), tag: 'div', cls: 'flex flex-col gap-4 p-4', children: selected }
    const build = (siblings: Node[]): Node[] => {
      const out: Node[] = []
      let placed = false
      for (const n of siblings) {
        if (ids.includes(n.id)) {
          if (!placed) {
            out.push(frame)
            placed = true
          }
        } else out.push(n)
      }
      if (!placed) out.push(frame)
      return out
    }
    const next =
      ctx.parentId == null
        ? mapArtboard(doc, ctx.artboardId, (ab) => ({ ...ab, nodes: build(ab.nodes) }))
        : mapNode(doc, ctx.parentId, (p) => ({ ...p, children: build(p.children) }))
    this.commit(next)
    this.state = { ...this.state, selection: frame.id, selectionSet: [frame.id] }
    this.emit()
  }
  /** Append a child node under a parent (or at artboard root when parentId is null). */
  addNode(artboardId: string, parentId: NodeId | null, node: Node) {
    let next: Doc
    if (parentId == null) {
      next = mapArtboard(this.state.doc, artboardId, (ab) => ({ ...ab, nodes: [...ab.nodes, node] }))
    } else {
      next = mapNode(this.state.doc, parentId, (p) => ({ ...p, children: [...p.children, node] }))
    }
    this.commit(next)
  }

  // --- artboards ---
  addArtboard(ab: Artboard) {
    this.commit({ ...this.state.doc, artboards: [...this.state.doc.artboards, ab] })
  }
  updateArtboard(id: string, patch: Partial<Artboard>) {
    this.commit(mapArtboard(this.state.doc, id, (ab) => ({ ...ab, ...patch })))
  }
  moveArtboard(id: string, x: number, y: number) {
    // position-only move shouldn't spam history; use set for the drag, commit on drop
    this.set({
      doc: { ...this.state.doc, artboards: this.state.doc.artboards.map((ab) => (ab.id === id ? { ...ab, x, y } : ab)) },
    })
  }
  commitArtboardMove() {
    this.onChange?.(this.state.doc)
  }
  deleteArtboard(id: string) {
    this.commit({ ...this.state.doc, artboards: this.state.doc.artboards.filter((ab) => ab.id !== id) })
  }

  // --- theme ---
  setTheme(patch: Partial<Doc['theme']>) {
    this.commit({ ...this.state.doc, theme: { ...this.state.doc.theme, ...patch } })
  }
  /** Apply a full palette preset (both light + dark) keeping fonts/radius/mode. */
  applyPalette(p: { name: string; light: Record<string, string>; dark: Record<string, string> }) {
    this.setTheme({ name: p.name, light: p.light, dark: p.dark })
  }
  /** Set one color token in the theme's ACTIVE mode palette. */
  setToken(key: string, value: string) {
    const t = this.state.doc.theme
    const palette = { ...(t.mode === 'dark' ? t.dark : t.light), [key]: value }
    this.setTheme(t.mode === 'dark' ? { dark: palette } : { light: palette })
  }

  /** Replace the whole doc (e.g. after an external refine/generate). */
  setDoc(doc: Doc) {
    this.commit(doc)
  }

  // --- transient edits (drag-resize): mutate live without spamming history,
  //     then land a single history entry on drop ---
  beginTransient(): Doc {
    return this.state.doc
  }
  previewNodeClasses(id: NodeId, cls: string) {
    this.set({ doc: mapNode(this.state.doc, id, (n) => ({ ...n, cls })) })
  }
  commitTransient(before: Doc) {
    if (before === this.state.doc) return
    this.history.push(before)
    if (this.history.length > 100) this.history.shift()
    this.future = []
    this.state = { ...this.state, dirty: true }
    this.emit()
    this.onChange?.(this.state.doc)
  }
}

// Camera persistence (per doc) ---------------------------------------------

const CAM_KEY = (id: string) => `ce-cam-${id}`
function saveCam(docId: string, cam: Camera) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(CAM_KEY(docId), JSON.stringify(cam))
  } catch {
    /* storage blocked */
  }
}
function loadCam(docId: string): Camera | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(CAM_KEY(docId))
    if (!raw) return null
    const c = JSON.parse(raw)
    if (typeof c?.x === 'number' && typeof c?.y === 'number' && typeof c?.z === 'number') return c
  } catch {
    /* ignore */
  }
  return null
}

// React binding ------------------------------------------------------------

export function useEditor(store: EditorStore): EditorState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

export { genId }
