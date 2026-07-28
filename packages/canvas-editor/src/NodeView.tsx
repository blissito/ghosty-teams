// Renders a Node as a REAL React element (createElement) with its Tailwind
// className — the canvas content is live DOM, not a picture. Adds data-id/data-tag
// for addressing + x-ray, click-to-select, and a selection outline.

import { createElement, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import type { Node } from './model'

const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'meta', 'link'])

// Parse a raw inline `style` attribute string into a React style object so we can
// preserve it verbatim (Teams artifacts / SDK sections often use inline styles).
function parseStyle(s: string): CSSProperties {
  const out: Record<string, string> = {}
  for (const decl of s.split(';')) {
    const i = decl.indexOf(':')
    if (i < 0) continue
    const prop = decl.slice(0, i).trim()
    const value = decl.slice(i + 1).trim()
    if (!prop) continue
    // custom properties (--x) stay as-is; others camelCase
    const key = prop.startsWith('--') ? prop : prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    out[key] = value
  }
  return out as CSSProperties
}

export function NodeView({
  node,
  selection,
  onSelect,
  interactive,
  editingId,
}: {
  node: Node
  selection: string[]
  onSelect: (id: string) => void
  interactive: boolean
  editingId?: string | null
}): ReactNode {
  const selected = selection.includes(node.id)
  const editing = editingId === node.id

  const props: Record<string, unknown> = {
    className: node.cls + (selected ? ' ce-selected' : ''),
    'data-id': node.id,
    'data-tag': node.tag,
  }
  if (node.src != null) props.src = node.src
  if (node.href != null) props.href = node.href
  if (node.style) props.style = parseStyle(node.style)
  if (node.hidden) props.hidden = true
  if (node.tag === 'input') props.readOnly = true

  if (interactive && !node.locked) {
    props.onClick = (e: MouseEvent) => {
      e.stopPropagation()
      onSelect(node.id)
    }
  }

  if (VOID_TAGS.has(node.tag)) {
    return createElement(node.tag, props)
  }

  const children: ReactNode[] = []
  if (node.text != null && node.text !== '') children.push(node.text)
  for (const c of node.children) {
    children.push(<NodeView key={c.id} node={c} selection={selection} onSelect={onSelect} interactive={interactive} editingId={editingId} />)
  }
  // inline text editing (double-click): keep the node laid out (so we can measure
  // it) but hide its text — the floating textarea overlay (Excalidraw/tldraw pattern)
  // is the single source of truth while editing.
  if (editing) {
    return createElement(node.tag, { ...props, style: { ...(props.style as CSSProperties), visibility: 'hidden' } }, ...children)
  }
  return createElement(node.tag, props, ...children)
}
