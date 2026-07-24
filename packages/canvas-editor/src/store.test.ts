import { describe, expect, it } from 'vitest'
import { EditorStore } from './store'
import { findNode, makeArtboard, type Doc, type Node } from './model'

function doc(): Doc {
  const a: Node = { id: 'a', tag: 'button', cls: '', text: 'A', children: [] }
  const b: Node = { id: 'b', tag: 'button', cls: '', text: 'B', children: [] }
  const c: Node = { id: 'c', tag: 'h2', cls: '', text: 'C', children: [] }
  const ab = { ...makeArtboard({ name: 'F', w: 400, h: 400 }), id: 'ab', nodes: [c, a, b] }
  return {
    id: 'd_store',
    artboards: [ab],
    theme: { name: 'x', mode: 'light', light: {}, dark: {}, fonts: { heading: 'a', body: 'b', mono: 'm' }, radius: '0' },
  }
}

describe('EditorStore selection', () => {
  it('single select replaces the set; toggle adds/removes', () => {
    const s = new EditorStore(doc())
    s.select('a')
    expect(s.getSnapshot().selectionSet).toEqual(['a'])
    s.toggleSelect('b')
    expect(s.getSnapshot().selectionSet).toEqual(['a', 'b'])
    expect(s.getSnapshot().selection).toBe('b')
    s.toggleSelect('a')
    expect(s.getSnapshot().selectionSet).toEqual(['b'])
  })
})

describe('EditorStore group / ungroup', () => {
  it('groups a multi-selection of siblings into one flex frame', () => {
    const s = new EditorStore(doc())
    s.select('a')
    s.toggleSelect('b')
    s.groupSelection()
    const nodes = s.getSnapshot().doc.artboards[0].nodes
    // c stays, a+b now wrapped in a new frame that replaced them at a's position
    expect(nodes.map((n) => n.id).includes('a')).toBe(false)
    const frame = nodes.find((n) => n.tag === 'div' && n.cls.includes('flex'))!
    expect(frame).toBeTruthy()
    expect(frame.children.map((n) => n.id)).toEqual(['a', 'b'])
    expect(s.getSnapshot().selection).toBe(frame.id)
  })

  it('ungroups a frame back into its parent', () => {
    const s = new EditorStore(doc())
    s.select('a')
    s.toggleSelect('b')
    s.groupSelection()
    const frameId = s.getSnapshot().selection!
    s.ungroupNode(frameId)
    const ids = s.getSnapshot().doc.artboards[0].nodes.map((n) => n.id)
    expect(ids).toEqual(['c', 'a', 'b'])
  })
})

describe('EditorStore duplicate', () => {
  it('duplicates a node as the next sibling with a fresh id', () => {
    const s = new EditorStore(doc())
    s.duplicateNode('a')
    const nodes = s.getSnapshot().doc.artboards[0].nodes
    expect(nodes.map((n) => n.id).filter((x) => x === 'a')).toHaveLength(1)
    // the copy sits right after 'a' and is a different node with same text
    const idx = nodes.findIndex((n) => n.id === 'a')
    const copy = nodes[idx + 1]
    expect(copy.id).not.toBe('a')
    expect(copy.text).toBe('A')
    expect(s.getSnapshot().selection).toBe(copy.id)
  })
})

describe('EditorStore undo/redo + dirty', () => {
  it('tracks dirty and reverts with undo', () => {
    const s = new EditorStore(doc())
    expect(s.getSnapshot().dirty).toBe(false)
    s.setNodeText('a', 'Z')
    expect(s.getSnapshot().dirty).toBe(true)
    expect(findNode(s.getSnapshot().doc, 'a')!.text).toBe('Z')
    s.undo()
    expect(findNode(s.getSnapshot().doc, 'a')!.text).toBe('A')
    s.markSaved()
    expect(s.getSnapshot().dirty).toBe(false)
  })
})
