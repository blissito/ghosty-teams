// Insertable blocks — the equivalent of efecto's `add_section`. Each factory
// returns a fresh Node subtree (new data-ids) styled with Tailwind. Includes
// shadcn-flavored primitives (button/card/input/badge) as static markup, plus
// composed sections (hero, features, CTA). All classes use semantic theme tokens
// where possible so themes/fonts swap live.

import type { Node } from './model'
import { genId } from './model'

function n(tag: string, cls: string, extra: Partial<Node> = {}): Node {
  return { id: genId(), tag, cls, children: [], ...extra }
}

export interface BlockDef {
  key: string
  label: string
  category: 'Basics' | 'shadcn' | 'Sections'
  make: () => Node
}

export const BLOCKS: BlockDef[] = [
  // --- Basics --- (fluid/responsive by default: clamp() type + wrapping layouts)
  { key: 'heading', label: 'Heading', category: 'Basics', make: () => n('h2', 'text-[clamp(1.5rem,4vw,2.25rem)] font-bold tracking-tight', { text: 'Heading' }) },
  { key: 'text', label: 'Text', category: 'Basics', make: () => n('p', 'text-[clamp(0.95rem,2vw,1rem)] text-muted-foreground leading-relaxed', { text: 'Body text goes here.' }) },
  { key: 'image', label: 'Image', category: 'Basics', make: () => n('img', 'w-full h-auto rounded-xl object-cover', { src: 'https://placehold.co/600x400' }) },
  { key: 'divider', label: 'Divider', category: 'Basics', make: () => n('hr', 'border-border my-6') },

  // --- shadcn primitives (static Tailwind markup) ---
  {
    key: 'button',
    label: 'Button',
    category: 'shadcn',
    make: () =>
      n(
        'button',
        'inline-flex items-center justify-center gap-2 rounded-[var(--radius)] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:opacity-90',
        { text: 'Button' },
      ),
  },
  {
    key: 'badge',
    label: 'Badge',
    category: 'shadcn',
    make: () =>
      n(
        'span',
        'inline-flex items-center rounded-full border border-border bg-secondary px-2.5 py-0.5 text-xs font-semibold text-secondary-foreground',
        { text: 'Badge' },
      ),
  },
  {
    key: 'input',
    label: 'Input',
    category: 'shadcn',
    make: () =>
      n(
        'input',
        'flex h-10 w-full rounded-[var(--radius)] border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40',
      ),
  },
  {
    key: 'card',
    label: 'Card',
    category: 'shadcn',
    make: () => ({
      ...n('div', 'rounded-[var(--radius)] border border-border bg-background p-6 shadow-sm'),
      children: [
        n('h3', 'text-lg font-semibold', { text: 'Card title' }),
        n('p', 'mt-1 text-sm text-muted-foreground', { text: 'Card description text.' }),
      ],
    }),
  },

  // --- Composed sections ---
  {
    key: 'hero',
    label: 'Hero',
    category: 'Sections',
    make: () => ({
      ...n('div', 'flex flex-col items-center gap-6 px-6 py-16 text-center'),
      children: [
        n('h1', 'text-[clamp(2rem,6vw,3.5rem)] font-bold tracking-tight', { text: 'Ready to Go Bananas?' }),
        n('p', 'max-w-xl text-[clamp(1rem,2.5vw,1.25rem)] text-muted-foreground', { text: 'A short, punchy subtitle that sells the idea.' }),
        {
          ...n('div', 'flex flex-wrap justify-center gap-3'),
          children: [
            n('button', 'rounded-[var(--radius)] bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground', { text: 'Get started' }),
            n('button', 'rounded-[var(--radius)] border border-border px-5 py-2.5 text-sm font-medium', { text: 'Learn more' }),
          ],
        },
      ],
    }),
  },
  {
    key: 'features',
    label: 'Features',
    category: 'Sections',
    // flex-wrap + min-w cards → 3-up on desktop, wraps to 1 column on mobile, no breakpoints
    make: () => ({
      ...n('div', 'flex flex-wrap justify-center gap-6 px-6 py-16'),
      children: [1, 2, 3].map((i) => ({
        ...n('div', 'flex-1 min-w-[240px] rounded-[var(--radius)] border border-border p-6'),
        children: [
          n('h3', 'text-[clamp(1.05rem,2vw,1.125rem)] font-semibold', { text: `Feature ${i}` }),
          n('p', 'mt-2 text-sm text-muted-foreground', { text: 'What this feature does for the user.' }),
        ],
      })),
    }),
  },
  {
    key: 'cta',
    label: 'CTA',
    category: 'Sections',
    make: () => ({
      ...n('div', 'flex flex-col items-center gap-4 bg-primary px-6 py-16 text-center text-primary-foreground'),
      children: [
        n('h2', 'text-[clamp(1.75rem,5vw,2.25rem)] font-bold', { text: 'Start today' }),
        n('button', 'rounded-[var(--radius)] bg-background px-5 py-2.5 text-sm font-medium text-foreground', { text: 'Sign up' }),
      ],
    }),
  },
]

export const BLOCKS_BY_CATEGORY = BLOCKS.reduce<Record<string, BlockDef[]>>((acc, b) => {
  ;(acc[b.category] ??= []).push(b)
  return acc
}, {})
