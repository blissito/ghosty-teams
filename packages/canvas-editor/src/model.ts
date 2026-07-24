// @ghosty/canvas-editor — canonical data model
// The document is a tree of real elements (rendered as React nodes, serialized to HTML).
// `cls` (Tailwind) is the source of truth for style; `id` (data-id) addresses targeted edits.

export type NodeId = string
export type ArtboardId = string

export interface Node {
  id: NodeId
  tag: string // h1..h6, p, div, section, button, a, img, span, ul, li ...
  cls: string // Tailwind utility classes — the source of truth for styling
  text?: string // text content for leaf text nodes
  src?: string // for <img>
  href?: string // for <a>
  hidden?: boolean // display:none (layer eye toggle)
  locked?: boolean // not selectable/draggable on canvas (layer lock toggle)
  children: Node[]
}

export interface Artboard {
  id: ArtboardId
  name: string
  x: number
  y: number
  w: number
  h: number
  cls?: string // artboard-level classes (background, padding, flex container...)
  nodes: Node[]
}

// Themes and fonts are SEPARATE axes (like efecto's Brand System).
export interface ThemeFonts {
  heading: string // e.g. "Inter", "Poppins"
  body: string
  mono: string
}

export interface Theme {
  name: string
  mode: 'light' | 'dark'
  // semantic color tokens per mode → CSS custom properties (bg-primary → --color-primary)
  light: Record<string, string>
  dark: Record<string, string>
  fonts: ThemeFonts
  radius: string // e.g. "0.5rem"
}

/** The active token palette for the theme's current mode (defensive against
 *  malformed/legacy themes that lack a palette). */
export function activeTokens(theme: Theme): Record<string, string> {
  return (theme.mode === 'dark' ? theme.dark : theme.light) ?? {}
}

export interface Doc {
  id: string
  artboards: Artboard[]
  theme: Theme
}

// ---------------------------------------------------------------------------
// Frame presets — dimensions the agent/user can request
// ---------------------------------------------------------------------------

export interface ArtboardPreset {
  key: string
  label: string
  w: number
  h: number
}

export const ARTBOARD_PRESETS: ArtboardPreset[] = [
  { key: 'desktop', label: 'Desktop', w: 1440, h: 1024 },
  { key: 'laptop', label: 'Laptop', w: 1280, h: 800 },
  { key: 'tablet', label: 'Tablet', w: 768, h: 1024 },
  { key: 'mobile', label: 'Mobile', w: 375, h: 812 },
  { key: 'ig-post', label: 'IG Post', w: 1080, h: 1080 },
  { key: 'ig-story', label: 'IG Story', w: 1080, h: 1920 },
  { key: 'card', label: 'Card', w: 360, h: 460 },
  { key: 'poster', label: 'Poster', w: 1080, h: 1350 },
  { key: 'a4', label: 'A4', w: 794, h: 1123 },
]

// ---------------------------------------------------------------------------
// Default theme
// ---------------------------------------------------------------------------

export const DEFAULT_THEME: Theme = {
  name: 'Neutral',
  mode: 'light',
  light: {
    background: '#ffffff',
    foreground: '#0a0a0a',
    primary: '#171717',
    'primary-foreground': '#fafafa',
    secondary: '#f5f5f5',
    'secondary-foreground': '#171717',
    muted: '#f5f5f5',
    'muted-foreground': '#737373',
    accent: '#f5f5f5',
    border: '#e5e5e5',
  },
  dark: {
    background: '#0a0a0a',
    foreground: '#fafafa',
    primary: '#fafafa',
    'primary-foreground': '#0a0a0a',
    secondary: '#1a1a1a',
    'secondary-foreground': '#fafafa',
    muted: '#1a1a1a',
    'muted-foreground': '#a3a3a3',
    accent: '#262626',
    border: '#262626',
  },
  fonts: { heading: 'Inter', body: 'Inter', mono: 'ui-monospace' },
  radius: '0.5rem',
}

/** Curated font families for the theme font selects. */
export const FONT_OPTIONS = [
  'Inter', 'Geist', 'Poppins', 'Montserrat', 'Playfair Display', 'Merriweather',
  'Space Grotesk', 'DM Sans', 'Sora', 'Lora', 'Roboto', 'Work Sans', 'ui-monospace',
]

// ---------------------------------------------------------------------------
// ID generation (dependency-free, no nanoid) — stable, URL-safe
// ---------------------------------------------------------------------------

const ALPHABET = 'useandom26T198340PX75pxJACKVERYMINDBUSHWOLFGQ_'
export function genId(prefix = 'n'): string {
  let id = ''
  for (let i = 0; i < 10; i++) {
    id += ALPHABET[(Math.random() * ALPHABET.length) | 0]
  }
  return `${prefix}_${id}`
}

// ---------------------------------------------------------------------------
// Tree helpers (pure, immutable)
// ---------------------------------------------------------------------------

/** Depth-first walk over every node in an artboard. */
export function walk(nodes: Node[], fn: (node: Node, parent: Node | null) => void, parent: Node | null = null): void {
  for (const node of nodes) {
    fn(node, parent)
    if (node.children.length) walk(node.children, fn, node)
  }
}

/** Find a node by id anywhere in the doc; returns the node or null. */
export function findNode(doc: Doc, id: NodeId): Node | null {
  let found: Node | null = null
  for (const ab of doc.artboards) {
    walk(ab.nodes, (n) => {
      if (n.id === id) found = n
    })
    if (found) break
  }
  return found
}

/** Find which artboard contains a node id. */
export function findArtboardOf(doc: Doc, id: NodeId): Artboard | null {
  for (const ab of doc.artboards) {
    let hit = false
    walk(ab.nodes, (n) => {
      if (n.id === id) hit = true
    })
    if (hit) return ab
  }
  return null
}

/** Immutably map a single node (by id) through `fn`, returning a new Doc. */
export function mapNode(doc: Doc, id: NodeId, fn: (node: Node) => Node): Doc {
  const mapNodes = (nodes: Node[]): Node[] =>
    nodes.map((n) => {
      if (n.id === id) return fn(n)
      if (n.children.length) return { ...n, children: mapNodes(n.children) }
      return n
    })
  return {
    ...doc,
    artboards: doc.artboards.map((ab) => ({ ...ab, nodes: mapNodes(ab.nodes) })),
  }
}

/** Immutably replace a node's whole subtree (by id) with `replacement`. */
export function replaceNode(doc: Doc, id: NodeId, replacement: Node): Doc {
  return mapNode(doc, id, () => replacement)
}

/** Immutably map a single artboard (by id). */
export function mapArtboard(doc: Doc, id: ArtboardId, fn: (ab: Artboard) => Artboard): Doc {
  return { ...doc, artboards: doc.artboards.map((ab) => (ab.id === id ? fn(ab) : ab)) }
}

/** True if `ancestorId` contains `nodeId` (or they're equal) in the doc tree. */
export function isAncestor(doc: Doc, ancestorId: NodeId, nodeId: NodeId): boolean {
  const anc = findNode(doc, ancestorId)
  if (!anc) return false
  if (ancestorId === nodeId) return true
  let hit = false
  walk(anc.children, (n) => {
    if (n.id === nodeId) hit = true
  })
  return hit
}

export interface MoveTarget {
  artboardId: ArtboardId
  parentId: NodeId | null // null = artboard root
  index: number
}

/**
 * Immutably move a node to a new parent/index (autolayout drag-reorder).
 * No-op if the target is inside the node's own subtree (would orphan the tree).
 */
export function moveNode(doc: Doc, nodeId: NodeId, target: MoveTarget): Doc {
  if (target.parentId && isAncestor(doc, nodeId, target.parentId)) return doc

  // 1. detach the node, remembering it
  let moved: Node | null = null
  const detach = (nodes: Node[]): Node[] =>
    nodes
      .filter((n) => {
        if (n.id === nodeId) {
          moved = n
          return false
        }
        return true
      })
      .map((n) => ({ ...n, children: detach(n.children) }))

  const detached: Doc = { ...doc, artboards: doc.artboards.map((ab) => ({ ...ab, nodes: detach(ab.nodes) })) }
  if (!moved) return doc

  // 2. insert at target
  const insert = (nodes: Node[]): Node[] => {
    const copy = nodes.slice()
    copy.splice(Math.max(0, Math.min(target.index, copy.length)), 0, moved as Node)
    return copy
  }
  return {
    ...detached,
    artboards: detached.artboards.map((ab) => {
      if (ab.id !== target.artboardId) return ab
      if (target.parentId == null) return { ...ab, nodes: insert(ab.nodes) }
      const intoParent = (nodes: Node[]): Node[] =>
        nodes.map((n) => (n.id === target.parentId ? { ...n, children: insert(n.children) } : { ...n, children: intoParent(n.children) }))
      return { ...ab, nodes: intoParent(ab.nodes) }
    }),
  }
}

/** Deep-copy a node subtree with fresh ids (Alt-drag clone, duplicate). */
export function cloneNode(node: Node): Node {
  return { ...node, id: genId(), children: node.children.map(cloneNode) }
}

/** Immutably insert a node subtree at a move target (used by clone-drop). */
export function insertNode(doc: Doc, target: MoveTarget, node: Node): Doc {
  const insertInto = (nodes: Node[]): Node[] => {
    const copy = nodes.slice()
    copy.splice(Math.max(0, Math.min(target.index, copy.length)), 0, node)
    return copy
  }
  return {
    ...doc,
    artboards: doc.artboards.map((ab) => {
      if (ab.id !== target.artboardId) return ab
      if (target.parentId == null) return { ...ab, nodes: insertInto(ab.nodes) }
      const into = (nodes: Node[]): Node[] =>
        nodes.map((n) => (n.id === target.parentId ? { ...n, children: insertInto(n.children) } : { ...n, children: into(n.children) }))
      return { ...ab, nodes: into(ab.nodes) }
    }),
  }
}

/** Create an empty artboard from a preset (or explicit dims), placed at x/y. */
export function makeArtboard(opts: { name?: string; w: number; h: number; x?: number; y?: number }): Artboard {
  return {
    id: genId('ab'),
    name: opts.name ?? 'Frame',
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    w: opts.w,
    h: opts.h,
    cls: 'bg-white',
    nodes: [],
  }
}

/** Create a fresh, empty document with one desktop artboard. */
export function makeEmptyDoc(id = genId('doc')): Doc {
  const preset = ARTBOARD_PRESETS[0]
  return {
    id,
    artboards: [makeArtboard({ name: 'Desktop', w: preset.w, h: preset.h, x: 0, y: 0 })],
    theme: { ...DEFAULT_THEME },
  }
}
