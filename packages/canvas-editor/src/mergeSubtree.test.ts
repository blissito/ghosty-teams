import { describe, expect, it } from 'vitest'
import { mergeSubtree } from './mergeSubtree'
import type { Node } from './model'

const n = (id: string, tag: string, extra: Partial<Node> = {}): Node => ({
  id,
  tag,
  cls: '',
  children: [],
  ...extra,
})

describe('mergeSubtree', () => {
  it('conserva el id de la raíz aunque el modelo lo cambie', () => {
    const prev = n('hero', 'section')
    const next = n('otro-id', 'section', { cls: 'bg-primary' })
    const out = mergeSubtree(prev, next)
    expect(out.id).toBe('hero')
    expect(out.cls).toBe('bg-primary')
  })

  it('reancla por posición+tag cuando el modelo omite los data-id (el caso real)', () => {
    const prev = n('hero', 'section', {
      children: [n('title', 'h2', { text: 'Antes' }), n('img1', 'img', { src: '/foto.jpg' })],
    })
    // Gemini devuelve el subárbol sin los data-id de los hijos.
    const next = n('hero', 'section', {
      children: [n('nuevo-1', 'h2', { text: 'Después' }), n('nuevo-2', 'img', { src: '/foto.jpg' })],
    })
    const out = mergeSubtree(prev, next)
    expect(out.children.map((c) => c.id)).toEqual(['title', 'img1'])
    expect(out.children[0].text).toBe('Después')
  })

  it('NO empareja por posición si cambió el tag', () => {
    const prev = n('hero', 'section', { children: [n('title', 'p')] })
    const next = n('hero', 'section', { children: [n('fresco', 'h2')] })
    const out = mergeSubtree(prev, next)
    expect(out.children[0].id).toBe('fresco')
  })

  it('prefiere el match por data-id sobre el posicional', () => {
    const prev = n('root', 'div', { children: [n('a', 'p'), n('b', 'p')] })
    // El modelo reordenó: devuelve 'b' primero, ambos con su id.
    const next = n('root', 'div', { children: [n('b', 'p'), n('a', 'p')] })
    const out = mergeSubtree(prev, next)
    expect(out.children.map((c) => c.id)).toEqual(['b', 'a'])
  })

  it('no funde un mismo nodo previo en dos hijos distintos', () => {
    const prev = n('root', 'div', { children: [n('a', 'p')] })
    // El modelo duplicó el párrafo: uno trae el id, el otro no.
    const next = n('root', 'div', { children: [n('a', 'p'), n('copia', 'p')] })
    const out = mergeSubtree(prev, next)
    expect(out.children.map((c) => c.id)).toEqual(['a', 'copia'])
  })

  it('hereda hidden/locked, que no viajan en el HTML', () => {
    const prev = n('root', 'div', { children: [n('a', 'img', { hidden: true, locked: true })] })
    const next = n('root', 'div', { children: [n('a', 'img', { src: '/nueva.jpg' })] })
    const out = mergeSubtree(prev, next)
    expect(out.children[0].hidden).toBe(true)
    expect(out.children[0].locked).toBe(true)
    expect(out.children[0].src).toBe('/nueva.jpg')
  })

  it('conserva los ids de los nietos', () => {
    const prev = n('root', 'section', {
      children: [n('wrap', 'div', { children: [n('t', 'h1', { text: 'a' })] })],
    })
    const next = n('root', 'section', {
      children: [n('x', 'div', { children: [n('y', 'h1', { text: 'b' })] })],
    })
    const out = mergeSubtree(prev, next)
    expect(out.children[0].id).toBe('wrap')
    expect(out.children[0].children[0].id).toBe('t')
    expect(out.children[0].children[0].text).toBe('b')
  })
})
