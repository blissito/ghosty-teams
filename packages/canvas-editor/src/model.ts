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

// Known community palettes (Tailwind/shadcn named themes). Each is built from a
// primary color over a neutral scaffold; primary-foreground is chosen for contrast.
function luminance(hex: string): number {
  const m = hex.replace('#', '')
  const r = parseInt(m.slice(0, 2), 16) / 255
  const g = parseInt(m.slice(2, 4), 16) / 255
  const b = parseInt(m.slice(4, 6), 16) / 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
/** Pick #0a0a0a or #fafafa for legible text over a background color. */
export function onColor(bg: string): string {
  return luminance(bg) > 0.55 ? '#0a0a0a' : '#fafafa'
}

export interface PalettePreset {
  name: string
  light: Record<string, string>
  dark: Record<string, string>
}

// Real, community-recognized palettes (contrast-vetted by their communities).
// Full semantic token sets so a generated theme is cohesive, not one-color.
function P(
  l: [string, string, string, string, string, string, string, string, string, string, string],
  d: [string, string, string, string, string, string, string, string, string, string, string],
) {
  const keys = ['background', 'foreground', 'primary', 'primary-foreground', 'secondary', 'secondary-foreground', 'muted', 'muted-foreground', 'accent', 'accent-foreground', 'border']
  const obj = (a: string[]) => Object.fromEntries(keys.map((k, i) => [k, a[i]])) as Record<string, string>
  return { light: obj(l), dark: obj(d) }
}

// Sourced + contrast-vetted (Nord, Catppuccin, Dracula, Rosé Pine, Tokyo Night,
// Atom One, Solarized, Gruvbox, Everforest, Ayu, Twitter/tweakcn, shadcn Zinc).
export const PALETTE_PRESETS: PalettePreset[] = [
  { name: 'shadcn Zinc', ...P(
    ['#ffffff', '#09090b', '#18181b', '#fafafa', '#f4f4f5', '#18181b', '#f4f4f5', '#71717a', '#f4f4f5', '#18181b', '#e4e4e7'],
    ['#09090b', '#fafafa', '#fafafa', '#18181b', '#27272a', '#fafafa', '#27272a', '#a1a1aa', '#27272a', '#fafafa', '#27272a']) },
  { name: 'Nord', ...P(
    ['#eceff4', '#2e3440', '#5e81ac', '#eceff4', '#d8dee9', '#2e3440', '#e5e9f0', '#4c566a', '#88c0d0', '#2e3440', '#d8dee9'],
    ['#2e3440', '#eceff4', '#88c0d0', '#2e3440', '#3b4252', '#eceff4', '#3b4252', '#d8dee9', '#434c5e', '#eceff4', '#3b4252']) },
  { name: 'Dracula', ...P(
    ['#fffbeb', '#1f1f1f', '#644ac9', '#fffbeb', '#efe9ce', '#1f1f1f', '#efe9ce', '#6c664b', '#a3144d', '#fffbeb', '#ddd6b8'],
    ['#282a36', '#f8f8f2', '#bd93f9', '#282a36', '#44475a', '#f8f8f2', '#44475a', '#6272a4', '#ff79c6', '#282a36', '#44475a']) },
  { name: 'Catppuccin', ...P(
    ['#eff1f5', '#4c4f69', '#8839ef', '#eff1f5', '#ccd0da', '#4c4f69', '#e6e9ef', '#6c6f85', '#dce0e8', '#4c4f69', '#ccd0da'],
    ['#1e1e2e', '#cdd6f4', '#cba6f7', '#1e1e2e', '#313244', '#cdd6f4', '#181825', '#a6adc8', '#45475a', '#cdd6f4', '#313244']) },
  { name: 'Rosé Pine', ...P(
    ['#faf4ed', '#575279', '#286983', '#faf4ed', '#f2e9e1', '#575279', '#fffaf3', '#797593', '#907aa9', '#faf4ed', '#dfdad9'],
    ['#191724', '#e0def4', '#c4a7e7', '#191724', '#26233a', '#e0def4', '#1f1d2e', '#908caa', '#403d52', '#e0def4', '#403d52']) },
  { name: 'Tokyo Night', ...P(
    ['#e1e2e7', '#3760bf', '#2e7de9', '#ffffff', '#d5d6db', '#3760bf', '#d5d6db', '#6172b0', '#9854f1', '#ffffff', '#a8aecb'],
    ['#1a1b26', '#c0caf5', '#7aa2f7', '#1a1b26', '#292e42', '#c0caf5', '#1f2335', '#a9b1d6', '#bb9af7', '#1a1b26', '#3b4261']) },
  { name: 'Atom One', ...P(
    ['#fafafa', '#383a42', '#4078f2', '#ffffff', '#e5e5e6', '#383a42', '#eaeaeb', '#696c77', '#a626a4', '#ffffff', '#d4d4d5'],
    ['#282c34', '#abb2bf', '#61afef', '#282c34', '#3e4451', '#abb2bf', '#21252b', '#828997', '#c678dd', '#282c34', '#3e4451']) },
  { name: 'Solarized', ...P(
    ['#fdf6e3', '#657b83', '#268bd2', '#fdf6e3', '#eee8d5', '#586e75', '#eee8d5', '#93a1a1', '#2aa198', '#002b36', '#e6dfc8'],
    ['#002b36', '#839496', '#268bd2', '#002b36', '#073642', '#93a1a1', '#073642', '#586e75', '#2aa198', '#002b36', '#073642']) },
  { name: 'Gruvbox', ...P(
    ['#fbf1c7', '#3c3836', '#af3a03', '#fbf1c7', '#ebdbb2', '#3c3836', '#ebdbb2', '#7c6f64', '#427b58', '#fbf1c7', '#d5c4a1'],
    ['#282828', '#ebdbb2', '#fe8019', '#282828', '#3c3836', '#ebdbb2', '#3c3836', '#a89984', '#504945', '#ebdbb2', '#504945']) },
  { name: 'Everforest', ...P(
    ['#fdf6e3', '#5c6a72', '#8da101', '#2d353b', '#efebd4', '#5c6a72', '#efebd4', '#829181', '#3a94c5', '#2d353b', '#e6e2cc'],
    ['#2d353b', '#d3c6aa', '#a7c080', '#2d353b', '#3d484d', '#d3c6aa', '#3d484d', '#859289', '#475258', '#d3c6aa', '#475258']) },
  { name: 'Ayu', ...P(
    ['#fafafa', '#5c6166', '#fa8d3e', '#3b3f42', '#f0f0f1', '#5c6166', '#f0f0f1', '#8a9199', '#399ee6', '#3b3f42', '#e7e8e9'],
    ['#0f1419', '#bfbdb6', '#ffb454', '#0f1419', '#1c232b', '#bfbdb6', '#151a1e', '#808b98', '#59c2ff', '#0f1419', '#1c232b']) },
  { name: 'Twitter', ...P(
    ['#ffffff', '#30313f', '#1da1f2', '#ffffff', '#30313f', '#ffffff', '#ebf0f5', '#64748b', '#f0f8ff', '#30313f', '#eceef4'],
    ['#000000', '#eff3f4', '#1da1f2', '#ffffff', '#f7f9fa', '#30313f', '#36363c', '#9aa0a6', '#1a2632', '#eff3f4', '#44444e']) },
]

/** Google Fonts stylesheet URL for the given families (skips system fonts).
 *  Used to actually load the fonts in the editor + exported HTML so selects
 *  preview correctly and the canvas renders the chosen typography. */
export function googleFontsHref(names: string[] = FONT_OPTIONS): string {
  const families = names
    .filter((n) => n && !n.startsWith('ui-') && !n.includes('monospace') && !n.includes('system'))
    .map((n) => `family=${n.trim().replace(/\s+/g, '+')}:wght@400;500;600;700;800`)
  return `https://fonts.googleapis.com/css2?${families.join('&')}&display=swap`
}

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

/** Locate a node: which artboard, its parent (null = artboard root), and index. */
export function locateNode(doc: Doc, id: NodeId): { artboardId: ArtboardId; parentId: NodeId | null; index: number } | null {
  for (const ab of doc.artboards) {
    const root = ab.nodes.findIndex((n) => n.id === id)
    if (root >= 0) return { artboardId: ab.id, parentId: null, index: root }
    let found: { artboardId: ArtboardId; parentId: NodeId | null; index: number } | null = null
    const dig = (parent: Node) => {
      if (found) return
      const i = parent.children.findIndex((n) => n.id === id)
      if (i >= 0) {
        found = { artboardId: ab.id, parentId: parent.id, index: i }
        return
      }
      parent.children.forEach(dig)
    }
    ab.nodes.forEach(dig)
    if (found) return found
  }
  return null
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
    // no hardcoded bg — the artboard follows the theme background (var(--color-background))
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
