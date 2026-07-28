import { describe, it, expect } from 'vitest'
import { extractEbDoc, isSameDocument } from './ebdoc'

describe('documento nuevo vs versión', () => {
  const cur = { kind: 'artifact' as const, md: '<div data-id="a1">viejo</div>' }
  it('la marca `nuevo` no se cuela en el título', () => {
    const d = extractEbDoc('```eb-artifact nuevo Propuesta Comercial\n<p>x</p>\n```')!
    expect(d.isNew).toBe(true)
    expect(d.fenceTitle).toBe('Propuesta Comercial')
    expect(isSameDocument(d, cur)).toBe(false)
  })
  it('re-emitir el mismo árbol sigue siendo una versión', () => {
    const d = extractEbDoc('```eb-artifact\n<div data-id="a1">nuevo texto</div>\n```')!
    expect(isSameDocument(d, cur)).toBe(true)
  })
  it('sin marca pero sin un solo data-id en común → otro documento', () => {
    const d = extractEbDoc('```eb-artifact\n<div data-id="z9">otra cosa</div>\n```')!
    expect(isSameDocument(d, cur)).toBe(false)
  })
  it('re-emisión SIN ids (el server los estampa al publicar) sigue siendo el mismo', () => {
    const d = extractEbDoc('```eb-artifact\n<div>rehecho entero</div>\n```')!
    expect(isSameDocument(d, cur)).toBe(true)
  })
})
