// @vitest-environment jsdom
// El caso real: el artefacto colorea con una regla propia (`.heading{color:…}`),
// no con clases Tailwind ni con style inline. El control de color tiene que
// (a) MOSTRAR ese color y (b) poder cambiarlo pase lo que pase.
import { afterEach, describe, expect, it } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'

afterEach(cleanup) // sin esto los tests se leen el DOM del test anterior
import { CanvasEditor } from './CanvasEditor'
import { htmlToDoc } from './serialize'

// jsdom no trae ResizeObserver (lo usa la cámara del canvas)
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never

const ARTIFACT =`<!doctype html><html data-theme="dark"><head><style>
  .heading { color: #e4117a; }
</style></head><body>
  <div data-id="wrap" class="p-4"><span data-id="n1" class="text-2xl font-black heading">1</span></div>
</body></html>`

function setup() {
  const doc = htmlToDoc(ARTIFACT)
  const css = '.ce-artboard .heading { color: #e4117a; }'
  const r = render(<CanvasEditor doc={doc} extraCss={css} />)
  // seleccionar el nodo hoja
  const el = document.querySelector('[data-id="n1"]') as HTMLElement
  act(() => {
    fireEvent.click(el)
  })
  return { doc, r }
}

describe('control de color contra CSS del artefacto', () => {
  it('el nodo queda seleccionado al primer clic (sin escalera)', () => {
    setup()
    expect(screen.getByText('Tipografía')).toBeTruthy()
    // el inspector muestra el nodo hoja, no el contenedor
    expect((document.querySelector('[data-id="n1"]') as HTMLElement).className).toContain('ce-selected')
  })

  it('elegir un token escribe la clase y el select la refleja', () => {
    setup()
    const selects = Array.from(document.querySelectorAll('select')) as HTMLSelectElement[]
    // el select de Text es el primero de la sección COLOR: lo ubicamos por sus opciones
    const textSel = selects.find((s) => Array.from(s.options).some((o) => o.value === 'text-primary'))!
    expect(textSel).toBeTruthy()
    act(() => {
      fireEvent.change(textSel, { target: { value: 'text-primary' } })
    })
    expect((document.querySelector('[data-id="n1"]') as HTMLElement).className).toContain('text-primary')
    expect(textSel.value).toBe('text-primary')
  })

  it('el color libre escribe la utilidad arbitraria', () => {
    setup()
    const colorInput = document.querySelector('input[type="color"]') as HTMLInputElement
    expect(colorInput).toBeTruthy()
    act(() => {
      fireEvent.input(colorInput, { target: { value: '#00ff00' } })
    })
    expect((document.querySelector('[data-id="n1"]') as HTMLElement).className).toContain('text-[#00ff00]')
  })
})

describe('lectura del color REAL (venga de donde venga)', () => {
  it('el swatch muestra el color que impone la regla .heading del artefacto', () => {
    setup()
    const swatch = (document.querySelector('input[type="color"]') as HTMLInputElement).parentElement!
    // el color no está en ninguna clase Tailwind ni en style inline: sale del <style>
    expect((document.querySelector('[data-id="n1"]') as HTMLElement).getAttribute('style')).toBeNull()
    expect(swatch.style.background).toContain('rgb(228, 17, 122)')
  })
})
