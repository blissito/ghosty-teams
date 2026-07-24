// Renders a Node as a REAL React element (createElement) with its Tailwind
// className — the canvas content is live DOM, not a picture. Adds data-id/data-tag
// for addressing + x-ray, click-to-select, and a selection outline.

import { createElement, type MouseEvent, type ReactNode } from 'react'
import type { Node } from './model'

const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'meta', 'link'])

export function NodeView({
  node,
  selection,
  onSelect,
  interactive,
}: {
  node: Node
  selection: string[]
  onSelect: (id: string) => void
  interactive: boolean
}): ReactNode {
  const selected = selection.includes(node.id)

  const props: Record<string, unknown> = {
    className: node.cls + (selected ? ' ce-selected' : ''),
    'data-id': node.id,
    'data-tag': node.tag,
  }
  if (node.src != null) props.src = node.src
  if (node.href != null) props.href = node.href
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
    children.push(<NodeView key={c.id} node={c} selection={selection} onSelect={onSelect} interactive={interactive} />)
  }
  return createElement(node.tag, props, ...children)
}
