// @vitest-environment jsdom
// Seleccionar CUALQUIER nodo no puede tirar el render: en Teams el panel vive
// dentro de un ErrorBoundary, así que un throw aquí "cierra" el artefacto y lo
// deja en un estado del que no se puede reabrir. Un clic por cada forma de nodo.
import { afterEach, describe, expect, it } from 'vitest'
import { render, fireEvent, act, cleanup } from '@testing-library/react'
import { CanvasEditor } from './CanvasEditor'
import { htmlToDoc } from './serialize'

afterEach(cleanup)
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never

const ARTIFACT = `<!doctype html><html data-theme="dark"><head><style>
  .hero { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; }
  .card { grid-column: span 2; background: linear-gradient(90deg,#111,#222); }
  .heading { color: #e4117a; -webkit-text-fill-color: transparent; background-clip: text; }
</style></head><body>
  <section data-id="hero" class="hero">
    <div data-id="card" class="card" style="position:absolute; inset: 0 auto auto 0">
      <span data-id="badge" class="badge">DESTACADO</span>
      <h2 data-id="h" class="heading">Título</h2>
      <p data-id="p">Texto</p>
      <a data-id="a" href="https://x.test">link</a>
      <button data-id="btn">Botón</button>
      <img data-id="img" src="https://x.test/i.png">
      <ul data-id="ul"><li data-id="li">item</li></ul>
      <input data-id="in">
      <hr data-id="hr">
    </div>
  </section>
</body></html>`

describe('seleccionar cualquier nodo no tira el render', () => {
  const ids = ['hero', 'card', 'badge', 'h', 'p', 'a', 'btn', 'img', 'ul', 'li', 'in', 'hr']
  for (const id of ids) {
    it(`clic en <${id}>`, () => {
      render(<CanvasEditor doc={htmlToDoc(ARTIFACT)} extraCss="" tailwindPlay={false} />)
      const el = document.querySelector(`[data-id="${id}"]`) as HTMLElement
      expect(el).toBeTruthy()
      expect(() =>
        act(() => {
          fireEvent.click(el)
        }),
      ).not.toThrow()
      // el inspector quedó renderizado (hay controles)
      expect(document.querySelectorAll('select').length).toBeGreaterThan(0)
    })
  }
})
