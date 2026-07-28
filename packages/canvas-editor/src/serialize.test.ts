// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { docToHtml, htmlToDoc, htmlToNode, nodeSubtreeToHtml } from './serialize'
import { makeArtboard, type Doc, type Node } from './model'

function sampleDoc(): Doc {
  const title: Node = { id: 'n_title', tag: 'h2', cls: 'text-3xl font-bold', text: 'Ready to Go Bananas?', children: [] }
  const btn: Node = { id: 'n_btn', tag: 'button', cls: 'px-4 py-2 rounded-full bg-primary', text: 'Order Online', children: [] }
  const img: Node = { id: 'n_img', tag: 'img', cls: 'w-full rounded-xl', src: 'https://x/y.png', children: [] }
  const hero: Node = {
    id: 'n_hero',
    tag: 'div',
    cls: 'flex flex-col items-center gap-4 p-8',
    children: [title, btn, img],
  }
  const ab = { ...makeArtboard({ name: 'Desktop', w: 1440, h: 1024 }), id: 'ab_1', nodes: [hero] }
  return {
    id: 'doc_test',
    artboards: [ab],
    theme: {
      name: 'Neutral',
      mode: 'dark',
      light: { background: '#ffffff', foreground: '#0a0a0a', primary: '#171717' },
      dark: { background: '#000000', foreground: '#ffffff', primary: '#7c3aed' },
      fonts: { heading: 'Poppins', body: 'Inter', mono: 'ui-monospace' },
      radius: '0.75rem',
    },
  }
}

describe('serialize round-trip', () => {
  it('preserves ids, tags, classes, text through docToHtml → htmlToDoc', () => {
    const doc = sampleDoc()
    const html = docToHtml(doc)
    const back = htmlToDoc(html, doc.id)

    expect(back.artboards).toHaveLength(1)
    const ab = back.artboards[0]
    expect(ab.id).toBe('ab_1')
    expect(ab.name).toBe('Desktop')
    expect(ab.w).toBe(1440)
    expect(ab.h).toBe(1024)

    const hero = ab.nodes[0]
    expect(hero.id).toBe('n_hero')
    expect(hero.tag).toBe('div')
    expect(hero.cls).toBe('flex flex-col items-center gap-4 p-8')
    expect(hero.children.map((c) => c.id)).toEqual(['n_title', 'n_btn', 'n_img'])

    const title = hero.children[0]
    expect(title.tag).toBe('h2')
    expect(title.cls).toBe('text-3xl font-bold')
    expect(title.text).toBe('Ready to Go Bananas?')

    const img = hero.children[2]
    expect(img.tag).toBe('img')
    expect(img.src).toBe('https://x/y.png')
    expect(img.children).toHaveLength(0)
  })

  it('preserves theme (mode, tokens, fonts, radius)', () => {
    const doc = sampleDoc()
    const back = htmlToDoc(docToHtml(doc), doc.id)
    expect(back.theme.mode).toBe('dark')
    expect(back.theme.dark.primary).toBe('#7c3aed')
    expect(back.theme.fonts.heading).toBe('Poppins')
    expect(back.theme.radius).toBe('0.75rem')
  })

  it('is idempotent: htmlToDoc(docToHtml(x)) twice yields identical HTML', () => {
    const doc = sampleDoc()
    const html1 = docToHtml(doc)
    const html2 = docToHtml(htmlToDoc(html1, doc.id))
    expect(html2).toBe(html1)
  })

  it('wraps foreign HTML (no artboards) into one desktop frame', () => {
    const foreign = '<html><body><div class="p-4"><h1 class="text-xl">Hi</h1></div></body></html>'
    const doc = htmlToDoc(foreign, 'doc_foreign')
    expect(doc.artboards).toHaveLength(1)
    expect(doc.artboards[0].nodes[0].tag).toBe('div')
    expect(doc.artboards[0].nodes[0].children[0].text).toBe('Hi')
  })

  // El bug real: un rediseño devolvió iconos SVG y salieron como cuadros vacíos
  // porque `viewBox` y `d` no sobrevivían el parseo.
  it('preserva los atributos que el modelo no tipa (SVG, alt, target)', () => {
    const html =
      '<div class="flex"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 12h16" stroke-width="2"/></svg><img src="/a.png" alt="Logo"><a href="/x" target="_blank" rel="noreferrer">ir</a></div>'
    const node = htmlToNode(html, 'n_root')!
    const svg = node.children[0]
    expect(svg.attrs?.viewBox).toBe('0 0 24 24')
    expect(svg.attrs?.['aria-hidden']).toBe('true')
    expect(svg.children[0].attrs?.d).toBe('M4 12h16')
    expect(svg.children[0].attrs?.['stroke-width']).toBe('2')
    expect(node.children[1].attrs?.alt).toBe('Logo')
    expect(node.children[2].attrs?.target).toBe('_blank')

    // …y vuelven a salir al serializar: si sólo se guardan, el refine los pierde
    // igual en el siguiente viaje de ida.
    const out = nodeSubtreeToHtml(node)
    expect(out).toContain('viewBox="0 0 24 24"')
    expect(out).toContain('d="M4 12h16"')
    expect(out).toContain('alt="Logo"')
  })

  // El refine devuelve UN elemento. Si el modelo se pasa y manda dos, envolverlos
  // cambiaría el tag del nodo (un <section> volvería como <div>) y con él su
  // layout: por eso el default sigue siendo quedarse con el primero, y envolver
  // es opt-in de quien carga contenido persistido.
  it('htmlToNode se queda con el primer elemento salvo wrapMultiple', () => {
    const html = '<section class="a">Uno</section><section class="b">Dos</section>'
    expect(htmlToNode(html, 'id')!.tag).toBe('section')
    const wrapped = htmlToNode(html, 'id', { wrapMultiple: true })!
    expect(wrapped.tag).toBe('div')
    expect(wrapped.children).toHaveLength(2)
  })

  it('<style> conserva su CSS y sus atributos al ir y volver', () => {
    const node = htmlToNode('<style media="print">.a > .b{color:red}</style>', 'id')!
    expect(node.text).toBe('.a > .b{color:red}')
    expect(node.attrs?.media).toBe('print')
    expect(nodeSubtreeToHtml(node)).toContain('.a > .b{color:red}')
  })

  it('nodeSubtreeToHtml emits a single node with data-id (for refine payloads)', () => {
    const node: Node = { id: 'n_x', tag: 'p', cls: 'text-sm', text: 'hola', children: [] }
    const html = nodeSubtreeToHtml(node)
    expect(html).toContain('data-id="n_x"')
    expect(html).toContain('class="text-sm"')
    expect(html).toContain('hola')
  })
})
