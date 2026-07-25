// MODELO DEL INSPECTOR (reescrito 2026-07-25)
//
// Antes el inspector escribía CLASES de Tailwind. Eso solo funciona si el editor
// es dueño del CSS — y no lo es: el agente estiliza con reglas de su propio
// <style>, con `style` inline, con posicionamiento absoluto. Cada control fallaba
// por la misma razón (la clase perdía contra el CSS del autor, o Tailwind ni
// siquiera la había generado).
//
// Modelo nuevo, el de GrapesJS/Webflow:
//   LEER  = getComputedStyle del nodo vivo. La verdad la manda el DOM.
//   ESCRIBIR = declaración en el `style` del nodo. Gana sobre clases y sobre el
//              <style> del documento, no depende de que Tailwind genere nada, y
//              se serializa solo (docToHtml ya emite `style`).
// Las clases del autor siguen visibles y removibles en su propio panel: son
// CONTENIDO del artefacto, no el mecanismo de edición.

export type Opt = [value: string, label: string]

/** '' = heredado/sin fijar (opción "—", que BORRA la declaración). */
export const CSS_OPTIONS: Record<string, Opt[]> = {
  'font-size': [
    ['0.75rem', 'xs'], ['0.875rem', 'sm'], ['1rem', 'base'], ['1.125rem', 'lg'], ['1.25rem', 'xl'],
    ['1.5rem', '2xl'], ['1.875rem', '3xl'], ['2.25rem', '4xl'], ['3rem', '5xl'], ['3.75rem', '6xl'], ['4.5rem', '7xl'],
  ],
  'line-height': [['1', 'none'], ['1.25', 'tight'], ['1.375', 'snug'], ['1.5', 'normal'], ['1.625', 'relaxed'], ['2', 'loose']],
  'font-weight': [['400', 'normal'], ['500', 'medium'], ['600', 'semibold'], ['700', 'bold'], ['800', 'extrabold'], ['900', 'black']],
  'letter-spacing': [['-0.05em', 'tighter'], ['-0.025em', 'tight'], ['0em', 'normal'], ['0.025em', 'wide'], ['0.05em', 'wider']],
  'text-align': [['left', 'left'], ['center', 'center'], ['right', 'right'], ['justify', 'justify']],
  position: [['static', 'static'], ['relative', 'relative'], ['absolute', 'absolute'], ['fixed', 'fixed'], ['sticky', 'sticky']],
  padding: [['0px', '0'], ['0.5rem', '2'], ['1rem', '4'], ['1.5rem', '6'], ['2rem', '8'], ['3rem', '12'], ['4rem', '16'], ['6rem', '24']],
  margin: [['0px', '0'], ['0.5rem', '2'], ['1rem', '4'], ['1.5rem', '6'], ['2rem', '8'], ['auto', 'auto']],
  gap: [['0px', '0'], ['0.25rem', '1'], ['0.5rem', '2'], ['0.75rem', '3'], ['1rem', '4'], ['1.5rem', '6'], ['2rem', '8'], ['3rem', '12']],
  'align-items': [['flex-start', 'start'], ['center', 'center'], ['flex-end', 'end'], ['stretch', 'stretch'], ['baseline', 'baseline']],
  'justify-content': [['flex-start', 'start'], ['center', 'center'], ['flex-end', 'end'], ['space-between', 'between'], ['space-around', 'around']],
  overflow: [['visible', 'visible'], ['hidden', 'hidden'], ['auto', 'auto'], ['scroll', 'scroll']],
  'border-width': [['0px', 'off'], ['1px', '1'], ['2px', '2'], ['4px', '4'], ['8px', '8']],
  'border-radius': [['0px', 'none'], ['0.25rem', 'sm'], ['0.5rem', 'lg'], ['0.75rem', 'xl'], ['1rem', '2xl'], ['9999px', 'full'], ['var(--radius)', 'tema']],
  'box-shadow': [
    ['none', 'none'],
    ['0 1px 2px rgba(0,0,0,.06)', 'sm'],
    ['0 1px 3px rgba(0,0,0,.12)', 'base'],
    ['0 4px 8px rgba(0,0,0,.14)', 'md'],
    ['0 10px 24px rgba(0,0,0,.18)', 'lg'],
    ['0 20px 48px rgba(0,0,0,.24)', 'xl'],
  ],
  opacity: [['1', '100'], ['0.9', '90'], ['0.75', '75'], ['0.5', '50'], ['0.25', '25'], ['0', '0']],
  'grid-template-columns': [
    ['repeat(1, minmax(0, 1fr))', '1'], ['repeat(2, minmax(0, 1fr))', '2'], ['repeat(3, minmax(0, 1fr))', '3'],
    ['repeat(4, minmax(0, 1fr))', '4'], ['repeat(5, minmax(0, 1fr))', '5'], ['repeat(6, minmax(0, 1fr))', '6'],
    // Responsivas: las columnas se acomodan solas al ancho. `auto-fit` ESTIRA las
    // que hay para llenar la fila (lo que uno quiere cuando "sobra espacio");
    // `auto-fill` deja los huecos vacíos.
    ['repeat(auto-fit, minmax(240px, 1fr))', 'auto-fit 240'],
    ['repeat(auto-fit, minmax(320px, 1fr))', 'auto-fit 320'],
    ['repeat(auto-fill, minmax(240px, 1fr))', 'auto-fill 240'],
  ],
}

/** Tokens del tema que puede tomar una propiedad de color. */
export const COLOR_TOKENS: Opt[] = [
  ['var(--color-foreground)', 'foreground'],
  ['var(--color-muted-foreground)', 'muted'],
  ['var(--color-background)', 'background'],
  ['var(--color-primary)', 'primary'],
  ['var(--color-primary-foreground)', 'on-primary'],
  ['var(--color-secondary)', 'secondary'],
  ['var(--color-secondary-foreground)', 'on-secondary'],
  ['var(--color-muted)', 'muted-bg'],
  ['var(--color-accent)', 'accent'],
  ['var(--color-border)', 'border'],
]

export type DisplayMode = 'block' | 'flex-row' | 'flex-col' | 'grid' | 'none'

export function displayOf(display: string, flexDirection: string): DisplayMode {
  if (display === 'none') return 'none'
  if (display === 'grid' || display === 'inline-grid') return 'grid'
  if (display === 'flex' || display === 'inline-flex') return flexDirection.startsWith('column') ? 'flex-col' : 'flex-row'
  return 'block'
}

/** Declaraciones a escribir para cada modo de display (null = borrar). */
export function displayDecls(mode: DisplayMode): Record<string, string | null> {
  switch (mode) {
    case 'block':
      return { display: 'block', 'flex-direction': null }
    case 'none':
      return { display: 'none', 'flex-direction': null }
    case 'grid':
      return { display: 'grid', 'flex-direction': null }
    case 'flex-row':
      return { display: 'flex', 'flex-direction': 'row' }
    case 'flex-col':
      return { display: 'flex', 'flex-direction': 'column' }
  }
}

export type Sizing = 'hug' | 'fill' | 'fixed'

/** Lee el modo de tamaño desde el valor CSS efectivo (auto / 100% / px). */
export function sizingOf(value: string): Sizing {
  const v = value.trim()
  if (v === 'auto' || v === '') return 'hug'
  if (v === '100%' || v === '-webkit-fill-available') return 'fill'
  return 'fixed'
}
export function sizingValue(s: Sizing, px: number): string {
  return s === 'hug' ? 'auto' : s === 'fill' ? '100%' : `${px}px`
}

/** `rgb(228, 17, 17)` → `#e41111`; deja pasar hex; null si no es color sólido. */
export function toHex(v: string): string | null {
  const s = v.trim()
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase()
  if (/^#[0-9a-fA-F]{3}$/.test(s)) return '#' + s.slice(1).split('').map((c) => c + c).join('')
  const m = s.match(/^rgba?\(([^)]+)\)/)
  if (!m) return null
  const parts = m[1].split(/[,\s/]+/).filter(Boolean)
  const [r, g, b] = parts.map((x) => parseInt(x, 10))
  if ([r, g, b].some((x) => !Number.isFinite(x))) return null
  // rgba(0,0,0,0) = transparente: no es un color que valga la pena mostrar
  if (parts.length > 3 && parseFloat(parts[3]) === 0) return null
  return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

/** El elemento vivo de un nodo dentro del lienzo (fuente de verdad para leer). */
export function nodeEl(id: string): HTMLElement | null {
  if (typeof document === 'undefined') return null
  const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&')
  return document.querySelector(`.ce-artboard [data-id="${esc}"]`) as HTMLElement | null
}

/**
 * Empareja un valor CSS efectivo con una opción del control. El computed llega
 * normalizado por el navegador (`24px`, `rgb(…)`) mientras las opciones están en
 * unidades de autor (`1.5rem`), así que compara también en px. Sin esto el select
 * mostraba "—" aunque el valor SÍ fuera uno de la lista.
 */
export function optionForValue(opts: Opt[], value: string): string {
  const v = value.trim()
  if (!v) return ''
  const exact = opts.find(([o]) => o === v)
  if (exact) return exact[0]
  const px = toPx(v)
  if (px == null) return ''
  const near = opts.find(([o]) => {
    const p = toPx(o)
    return p != null && Math.abs(p - px) < 0.5
  })
  return near ? near[0] : ''
}

/** rem/em/px/número → px (raíz 16). null si no es una longitud simple. */
function toPx(v: string): number | null {
  const m = v.trim().match(/^(-?[\d.]+)(px|rem|em)?$/)
  if (!m) return null
  const n = parseFloat(m[1])
  if (!Number.isFinite(n)) return null
  return m[2] === 'rem' || m[2] === 'em' ? n * 16 : n
}
