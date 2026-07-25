// El agente estiliza como se le da la gana: clases Tailwind, `style="…"` inline, o
// reglas propias en el <style> del artefacto (ej. `.heading { color: … }`). El
// inspector no puede asumir una sola estrategia: LEE la verdad del DOM (computed
// style) y, al escribir, GARANTIZA el resultado — si la clase no logró cambiar el
// pixel (porque una regla del artefacto le gana), escala a `style` inline, que gana
// sobre clases y sobre el <style> del documento.

import type { EditorStore } from './store'

export function nodeEl(id: string): HTMLElement | null {
  if (typeof document === 'undefined') return null
  const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&')
  return document.querySelector(`.ce-artboard [data-id="${esc}"]`) as HTMLElement | null
}

/** Valor computado de una propiedad para el nodo (venga de donde venga), o ''. */
export function computedProp(id: string, prop: string): string {
  const el = nodeEl(id)
  if (!el) return ''
  return getComputedStyle(el).getPropertyValue(prop).trim()
}

/** `rgb(228, 17, 17)` → `#e41111` (para sembrar el input type=color). */
export function rgbToHex(v: string): string | null {
  const m = v.match(/rgba?\(([^)]+)\)/)
  if (!m) return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null
  const [r, g, b] = m[1].split(',').map((x) => parseInt(x.trim(), 10))
  if ([r, g, b].some((x) => !Number.isFinite(x))) return null
  return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

/**
 * Aplica clases y verifica que hayan surtido efecto. Si el pixel no cambió (una
 * regla del artefacto pisa la clase), escribe la declaración inline. `inlineValue`
 * null = no hay nada que garantizar (ej. se eligió "—" para limpiar).
 */
export function applyGuaranteed(
  store: EditorStore,
  id: string,
  cls: string,
  strip: string[],
  guarantee?: { prop: string; value: string },
): void {
  const before = guarantee ? computedProp(id, guarantee.prop) : ''
  store.setNodeClassesOverriding(id, cls, strip)
  if (!guarantee || typeof window === 'undefined') return
  // Tailwind Play genera las utilidades de forma asíncrona → damos un respiro
  // antes de juzgar. Escalar de más solo duplica el valor (inofensivo).
  window.setTimeout(() => {
    if (computedProp(id, guarantee.prop) === before) {
      store.setNodeStyleProp(id, guarantee.prop, guarantee.value)
    }
  }, 220)
}
