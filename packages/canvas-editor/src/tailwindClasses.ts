// Utilidades de CLASES: solo lo que sigue vivo tras pasar el inspector a CSS —
// el panel de clases (chips + autocomplete) y la limpieza de declaraciones inline.

export type ClassCategory = { label: string; classes: string[] }

export const CLASS_CATALOG: ClassCategory[] = [
  { label: 'Layout', classes: ['block', 'inline-block', 'flex', 'inline-flex', 'grid', 'hidden', 'relative', 'absolute', 'sticky'] },
  { label: 'Flex', classes: ['flex-row', 'flex-col', 'items-start', 'items-center', 'items-end', 'justify-start', 'justify-center', 'justify-between', 'justify-end', 'flex-wrap', 'gap-1', 'gap-2', 'gap-3', 'gap-4', 'gap-6', 'gap-8'] },
  { label: 'Spacing', classes: ['p-2', 'p-4', 'p-6', 'p-8', 'px-4', 'py-2', 'px-6', 'py-4', 'm-2', 'm-4', 'mt-4', 'mb-4', 'mx-auto'] },
  { label: 'Size', classes: ['w-full', 'w-auto', 'w-1/2', 'w-1/3', 'h-full', 'h-auto', 'grow', 'shrink-0', 'max-w-xl', 'max-w-3xl', 'min-h-screen'] },
  { label: 'Typography', classes: ['text-xs', 'text-sm', 'text-base', 'text-lg', 'text-xl', 'text-2xl', 'text-3xl', 'text-4xl', 'text-5xl', 'font-normal', 'font-medium', 'font-semibold', 'font-bold', 'text-center', 'leading-tight', 'leading-relaxed', 'tracking-tight'] },
  { label: 'Colors', classes: ['bg-background', 'bg-primary', 'bg-secondary', 'bg-muted', 'text-foreground', 'text-muted-foreground', 'text-primary-foreground', 'border', 'border-border'] },
  { label: 'Radius/Shadow', classes: ['rounded-none', 'rounded', 'rounded-lg', 'rounded-xl', 'rounded-full', 'rounded-[var(--radius)]', 'shadow-sm', 'shadow', 'shadow-md', 'shadow-lg'] },
]

const ALL_CLASSES = Array.from(new Set(CLASS_CATALOG.flatMap((c) => c.classes)))

export function classList(cls: string): string[] {
  return cls.split(/\s+/).filter(Boolean)
}
export function hasClass(cls: string, c: string): boolean {
  return classList(cls).includes(c)
}
export function addClass(cls: string, c: string): string {
  if (hasClass(cls, c)) return cls
  return [...classList(cls), c].join(' ')
}
export function removeClass(cls: string, c: string): string {
  return classList(cls).filter((x) => x !== c).join(' ')
}
export function toggleClass(cls: string, c: string): string {
  return hasClass(cls, c) ? removeClass(cls, c) : addClass(cls, c)
}
/** Replace any class matching `prefixRe` with `next` (e.g. swap the display or width mode). */
export function replaceGroup(cls: string, group: string[], next: string | null): string {
  const kept = classList(cls).filter((x) => !group.includes(x))
  return (next ? [...kept, next] : kept).join(' ')
}

export function autocomplete(query: string, limit = 8): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return ALL_CLASSES.filter((c) => c.includes(q)).slice(0, limit)
}

/**
 * Quita declaraciones de un atributo `style` inline. Sirve para que una clase del
 * inspector pueda ganar: el inline gana SIEMPRE sobre cualquier clase, así que
 * poner `text-[#e41111]` sobre un `<span style="color:#a78bfa">` no pintaba nada.
 */
export function stripStyleProps(style: string | undefined, props: string[]): string {
  if (!style) return ''
  const drop = new Set(props.map((p) => p.toLowerCase()))
  return style
    .split(';')
    .filter((decl) => {
      const i = decl.indexOf(':')
      if (i < 0) return decl.trim() !== ''
      return !drop.has(decl.slice(0, i).trim().toLowerCase())
    })
    .map((d) => d.trim())
    .filter(Boolean)
    .join('; ')
}

/** Props inline que hay que limpiar al fijar cada cosa desde el inspector. */
export const STYLE_CONFLICTS = {
  // `-webkit-text-fill-color:transparent` + background-clip:text es el truco de
  // texto en degradado: si no se quita, el color elegido queda invisible.
  text: ['color', '-webkit-text-fill-color', 'background-clip', '-webkit-background-clip'],
  bg: ['background', 'background-color', 'background-image'],
  border: ['border-color', 'border'],
  fontSize: ['font-size'],
} as const

