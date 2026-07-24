import { describe, expect, it } from 'vitest'
import { findArtboardOf, findNode, isAncestor, moveNode, type Doc, type Node } from './model'

function doc(): Doc {
  const a: Node = { id: 'a', tag: 'div', cls: '', children: [] }
  const b: Node = { id: 'b', tag: 'div', cls: '', children: [] }
  const c: Node = { id: 'c', tag: 'span', cls: '', text: 'c', children: [] }
  const box: Node = { id: 'box', tag: 'div', cls: 'flex', children: [a, b] }
  return {
    id: 'd',
    artboards: [{ id: 'ab', name: 'F', x: 0, y: 0, w: 100, h: 100, nodes: [box, c] }],
    theme: { name: 'x', mode: 'light', light: {}, dark: {}, fonts: { heading: 'a', body: 'b', mono: 'm' }, radius: '0' },
  }
}

describe('moveNode', () => {
  it('reorders siblings inside a flex parent', () => {
    const d = moveNode(doc(), 'b', { artboardId: 'ab', parentId: 'box', index: 0 })
    const box = findNode(d, 'box')!
    expect(box.children.map((n) => n.id)).toEqual(['b', 'a'])
  })

  it('moves a node from artboard root into a parent', () => {
    const d = moveNode(doc(), 'c', { artboardId: 'ab', parentId: 'box', index: 1 })
    const box = findNode(d, 'box')!
    expect(box.children.map((n) => n.id)).toEqual(['a', 'c', 'b'])
    // c is no longer at artboard root
    expect(d.artboards[0].nodes.map((n) => n.id)).toEqual(['box'])
  })

  it('moves a node out to artboard root', () => {
    const d = moveNode(doc(), 'a', { artboardId: 'ab', parentId: null, index: 0 })
    expect(d.artboards[0].nodes.map((n) => n.id)).toEqual(['a', 'box', 'c'])
    expect(findNode(d, 'box')!.children.map((n) => n.id)).toEqual(['b'])
  })

  it('is a no-op when dropping a node into its own subtree', () => {
    const before = doc()
    const after = moveNode(before, 'box', { artboardId: 'ab', parentId: 'a', index: 0 })
    // 'a' is inside 'box' → illegal, unchanged structure
    expect(findNode(after, 'box')!.children.map((n) => n.id)).toEqual(['a', 'b'])
  })

  it('isAncestor and findArtboardOf work', () => {
    const d = doc()
    expect(isAncestor(d, 'box', 'a')).toBe(true)
    expect(isAncestor(d, 'a', 'box')).toBe(false)
    expect(findArtboardOf(d, 'b')!.id).toBe('ab')
  })
})
