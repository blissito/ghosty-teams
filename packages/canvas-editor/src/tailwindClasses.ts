// Tailwind class utilities for the Inspector. Logic ported/condensed from
// easybits `TailwindClassEditor.tsx` (categories + autocomplete), plus autolayout
// (flexbox) and sizing (Hug/Fixed/Fill) mapping like efecto.

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

// --- Autolayout (flexbox) & sizing (Hug/Fixed/Fill) -----------------------

export type Display = 'block' | 'flex-row' | 'flex-col' | 'grid' | 'hidden'
const DISPLAY_GROUP = ['block', 'flex', 'inline-flex', 'grid', 'hidden', 'flex-row', 'flex-col']

export function getDisplay(cls: string): Display {
  const list = classList(cls)
  if (list.includes('hidden')) return 'hidden'
  if (list.includes('grid')) return 'grid'
  if (list.includes('flex') || list.includes('inline-flex')) {
    return list.includes('flex-col') ? 'flex-col' : 'flex-row'
  }
  return 'block'
}
export function setDisplay(cls: string, d: Display): string {
  const cleaned = replaceGroup(cls, DISPLAY_GROUP, null)
  switch (d) {
    case 'block':
      return addClass(cleaned, 'block')
    case 'hidden':
      return addClass(cleaned, 'hidden')
    case 'grid':
      return addClass(cleaned, 'grid')
    case 'flex-row':
      return addClass(addClass(cleaned, 'flex'), 'flex-row')
    case 'flex-col':
      return addClass(addClass(cleaned, 'flex'), 'flex-col')
  }
}

// Structured property groups (efecto-style dropdowns). Each is a list of
// [className, label]; the inspector detects the current one and swaps within the group.
export type PropOption = [string, string]
export const GROUPS: Record<string, PropOption[]> = {
  size: [
    ['text-xs', 'xs'], ['text-sm', 'sm'], ['text-base', 'base'], ['text-lg', 'lg'], ['text-xl', 'xl'],
    ['text-2xl', '2xl'], ['text-3xl', '3xl'], ['text-4xl', '4xl'], ['text-5xl', '5xl'], ['text-6xl', '6xl'], ['text-7xl', '7xl'],
  ],
  leading: [['leading-none', 'none'], ['leading-tight', 'tight'], ['leading-snug', 'snug'], ['leading-normal', 'normal'], ['leading-relaxed', 'relaxed'], ['leading-loose', 'loose']],
  weight: [['font-normal', 'normal'], ['font-medium', 'medium'], ['font-semibold', 'semibold'], ['font-bold', 'bold'], ['font-extrabold', 'extrabold']],
  tracking: [['tracking-tighter', 'tighter'], ['tracking-tight', 'tight'], ['tracking-normal', 'normal'], ['tracking-wide', 'wide'], ['tracking-wider', 'wider']],
  align: [['text-left', 'left'], ['text-center', 'center'], ['text-right', 'right']],
  padding: [['p-0', '0'], ['p-2', '2'], ['p-4', '4'], ['p-6', '6'], ['p-8', '8'], ['p-12', '12'], ['p-16', '16'], ['p-24', '24']],
  margin: [['m-0', '0'], ['m-2', '2'], ['m-4', '4'], ['m-6', '6'], ['m-8', '8'], ['mx-auto', 'x-auto']],
  gap: [['gap-0', '0'], ['gap-1', '1'], ['gap-2', '2'], ['gap-3', '3'], ['gap-4', '4'], ['gap-6', '6'], ['gap-8', '8']],
  items: [['items-start', 'start'], ['items-center', 'center'], ['items-end', 'end'], ['items-stretch', 'stretch']],
  justify: [['justify-start', 'start'], ['justify-center', 'center'], ['justify-between', 'between'], ['justify-end', 'end'], ['justify-around', 'around']],
  overflow: [['overflow-visible', 'visible'], ['overflow-hidden', 'hidden'], ['overflow-auto', 'auto'], ['overflow-scroll', 'scroll']],
  textColor: [['text-foreground', 'foreground'], ['text-muted-foreground', 'muted'], ['text-primary-foreground', 'on-primary'], ['text-secondary-foreground', 'on-secondary']],
  bgColor: [['bg-background', 'background'], ['bg-primary', 'primary'], ['bg-secondary', 'secondary'], ['bg-muted', 'muted']],
  radius: [['rounded-none', 'none'], ['rounded', 'sm'], ['rounded-lg', 'lg'], ['rounded-xl', 'xl'], ['rounded-2xl', '2xl'], ['rounded-full', 'full'], ['rounded-[var(--radius)]', 'theme']],
  shadow: [['shadow-none', 'none'], ['shadow-sm', 'sm'], ['shadow', 'base'], ['shadow-md', 'md'], ['shadow-lg', 'lg'], ['shadow-xl', 'xl'], ['shadow-2xl', '2xl']],
  opacity: [['opacity-100', '100'], ['opacity-90', '90'], ['opacity-75', '75'], ['opacity-50', '50'], ['opacity-25', '25'], ['opacity-0', '0']],
}

/** Current value of a group (the class present), or '' if none. */
export function groupValue(cls: string, group: PropOption[]): string {
  const list = classList(cls)
  for (const [c] of group) if (list.includes(c)) return c
  return ''
}
/** Set (or clear with '') the group's class, removing any sibling in the group. */
export function setGroup(cls: string, group: PropOption[], value: string): string {
  return replaceGroup(cls, group.map(([c]) => c), value || null)
}

export type Sizing = 'hug' | 'fill' | 'fixed'
const W_GROUP = ['w-full', 'w-auto', 'grow']
export function getWidthSizing(cls: string): Sizing {
  const list = classList(cls)
  if (list.includes('w-full') || list.includes('grow')) return 'fill'
  if (list.some((c) => /^w-\[.+\]$/.test(c) || /^w-\d/.test(c))) return 'fixed'
  return 'hug' // w-auto or unspecified
}
export function setWidthSizing(cls: string, s: Sizing, fixedPx = 320): string {
  const cleaned = replaceGroup(cls, W_GROUP, null)
    .split(/\s+/)
    .filter((c) => !/^w-\[.+\]$/.test(c) && !/^w-\d/.test(c))
    .join(' ')
  if (s === 'hug') return addClass(cleaned, 'w-auto')
  if (s === 'fill') return addClass(cleaned, 'w-full')
  return addClass(cleaned, `w-[${fixedPx}px]`)
}

const H_GROUP = ['h-full', 'h-auto', 'grow']
export function getHeightSizing(cls: string): Sizing {
  const list = classList(cls)
  if (list.includes('h-full')) return 'fill'
  if (list.some((c) => /^h-\[.+\]$/.test(c) || /^h-\d/.test(c))) return 'fixed'
  return 'hug'
}
export function setHeightSizing(cls: string, s: Sizing, fixedPx = 240): string {
  const cleaned = replaceGroup(cls, H_GROUP, null)
    .split(/\s+/)
    .filter((c) => !/^h-\[.+\]$/.test(c) && !/^h-\d/.test(c))
    .join(' ')
  if (s === 'hug') return addClass(cleaned, 'h-auto')
  if (s === 'fill') return addClass(cleaned, 'h-full')
  return addClass(cleaned, `h-[${fixedPx}px]`)
}
