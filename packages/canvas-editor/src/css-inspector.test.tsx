// @vitest-environment jsdom
// El inspector edita CSS, no clases: lee el valor EFECTIVO del DOM (venga de una
// clase, de una regla del <style> del artefacto o de inline) y escribe una
// declaración inline, que gana sobre todo. Estos tests usan artefactos escritos
// como los escribe el agente: con su propio CSS.
import { afterEach, describe, expect, it } from 'vitest'
import { render, fireEvent, act, cleanup } from '@testing-library/react'
import { CanvasEditor } from './CanvasEditor'
import { htmlToDoc } from './serialize'

afterEach(cleanup) // sin esto los tests se leen el DOM del test anterior

// jsdom no trae ResizeObserver (lo usa la cámara del canvas)
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never

const el = (id: string) => document.querySelector(`[data-id="${id}"]`) as HTMLElement
const style = (id: string) => el(id).getAttribute('style') ?? ''
const selects = () => Array.from(document.querySelectorAll('select')) as HTMLSelectElement[]
/** El select cuyo menú ofrece `value` (así ubicamos cada control por su contenido). */
const selectWith = (value: string) => selects().find((s) => Array.from(s.options).some((o) => o.value === value))!

function mount(html: string, css: string, id: string) {
  render(<CanvasEditor doc={htmlToDoc(html)} extraCss={css} />)
  act(() => {
    fireEvent.click(el(id))
  })
}

describe('color contra el CSS del artefacto', () => {
  const HTML = `<!doctype html><html><body>
    <div data-id="wrap" class="p-4"><span data-id="n1" class="text-2xl heading">1</span></div>
  </body></html>`
  const CSS = '.ce-artboard .heading { color: #e4117a; }'

  it('el swatch muestra el color que impone la regla .heading (no hay clase ni inline)', () => {
    mount(HTML, CSS, 'n1')
    expect(el('n1').getAttribute('style')).toBeNull()
    const swatch = (document.querySelector('input[type="color"]') as HTMLInputElement).parentElement!
    expect(swatch.style.background).toContain('rgb(228, 17, 122)')
  })

  it('elegir un token del tema escribe la declaración inline', () => {
    mount(HTML, CSS, 'n1')
    act(() => {
      fireEvent.change(selectWith('var(--color-primary)'), { target: { value: 'var(--color-primary)' } })
    })
    expect(style('n1')).toContain('color: var(--color-primary)')
  })

  it('el color libre escribe el hex y le gana a la regla del artefacto', () => {
    mount(HTML, CSS, 'n1')
    act(() => {
      fireEvent.input(document.querySelector('input[type="color"]')!, { target: { value: '#00ff00' } })
    })
    // (jsdom normaliza el hex a rgb() al escribir el atributo style)
    expect(getComputedStyle(el('n1')).color).toBe('rgb(0, 255, 0)')
  })
})

describe('tamaño de texto contra el CSS del autor', () => {
  it('el select gana aunque el tamaño lo fije una regla del artefacto', () => {
    const HTML = `<!doctype html><html><body>
      <p data-id="t1" class="fluid">Hola</p></body></html>`
    mount(HTML, '.ce-artboard .fluid { font-size: 12px; }', 't1')
    act(() => {
      fireEvent.change(selectWith('1.875rem'), { target: { value: '1.875rem' } })
    })
    expect(style('t1')).toContain('font-size: 1.875rem')
  })
})

describe('layout: el nodo COMO HIJO de su contenedor', () => {
  // El caso bento: el CSS del autor clava cada tarjeta en una celda concreta. Cambiar
  // las columnas del padre no las mueve — hay que poder ver y quitar esa colocación.
  const HTML = `<!doctype html><html><body>
    <div data-id="bento" class="bento">
      <div data-id="c1" class="card">A</div>
      <div data-id="c2" class="card">B</div>
    </div></body></html>`
  const CSS = `.ce-artboard .bento { display: grid; grid-template-columns: repeat(2, 1fr); }
               .ce-artboard .card { grid-column: 1 / 2; grid-row: 1 / 2; }`

  it('aparece el panel del hijo con su colocación en el grid', () => {
    mount(HTML, CSS, 'c1')
    expect(document.body.textContent).toContain('En el contenedor')
    expect(selectWith('span 2')).toBeTruthy()
  })

  it('se puede soltar la colocación que impuso el autor', () => {
    mount(HTML, CSS, 'c1')
    act(() => {
      fireEvent.change(selectWith('span 2'), { target: { value: 'auto' } })
    })
    expect(style('c1')).toContain('grid-column: auto')
  })

  it('el contenedor flex expone wrap (antes no existía)', () => {
    mount(HTML, '.ce-artboard .bento { display: flex; }', 'bento')
    expect(selectWith('wrap')).toBeTruthy()
    act(() => {
      fireEvent.change(selectWith('wrap'), { target: { value: 'wrap' } })
    })
    expect(style('bento')).toContain('flex-wrap: wrap')
  })
})

describe('el resize escribe por el MISMO canal que el inspector', () => {
  it('arrastrar un handle deja el ancho en CSS (y por tanto visible en W)', () => {
    const HTML = `<!doctype html><html><body><div data-id="box">x</div></body></html>`
    mount(HTML, '', 'box')
    const handles = Array.from(document.querySelectorAll('span[style*="cursor"]')) as HTMLElement[]
    const east = handles.find((h) => h.style.cursor === 'ew-resize')!
    expect(east).toBeTruthy()
    act(() => {
      fireEvent.pointerDown(east, { clientX: 100, clientY: 0 })
      fireEvent(window, new MouseEvent('pointermove', { clientX: 260, clientY: 0 }) as never)
      fireEvent(window, new MouseEvent('pointerup') as never)
    })
    expect(style('box')).toMatch(/width: \d+px/)
    expect(el('box').className).not.toMatch(/w-\[/)
  })
})
