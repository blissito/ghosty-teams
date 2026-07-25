// Los controles del inspector tienen que GANARLE a las clases arbitrarias que
// traen los bloques insertables y los artefactos del agente.
import { describe, expect, it } from 'vitest'
import { getColorClass, getTextSize, setColorClass, setTextSize, colorClassHex } from './tailwindClasses'

describe('text size', () => {
  const fluid = 'text-[clamp(0.95rem,2vw,1rem)] text-muted-foreground leading-relaxed'

  it('reporta el tamaño arbitrario como valor actual', () => {
    expect(getTextSize(fluid)).toBe('text-[clamp(0.95rem,2vw,1rem)]')
    expect(getTextSize('text-3xl font-bold')).toBe('text-3xl')
  })

  it('al fijar un tamaño QUITA el arbitrario (si no, no cambiaba nada)', () => {
    const out = setTextSize(fluid, 'text-3xl')
    expect(out).toContain('text-3xl')
    expect(out).not.toContain('clamp')
    // no toca el color ni el leading
    expect(out).toContain('text-muted-foreground')
    expect(out).toContain('leading-relaxed')
  })

  it('no confunde un color arbitrario con un tamaño', () => {
    const cls = 'text-[#ff0055] text-lg'
    expect(getTextSize(cls)).toBe('text-lg')
    expect(setTextSize(cls, 'text-xl')).toContain('text-[#ff0055]')
  })
})

describe('color libre', () => {
  it('detecta token y hex', () => {
    expect(getColorClass('p-4 text-foreground', 'text')).toBe('text-foreground')
    expect(getColorClass('p-4 text-[#ff0055] text-2xl', 'text')).toBe('text-[#ff0055]')
    expect(getColorClass('bg-[var(--color-primary)]', 'bg')).toBe('bg-[var(--color-primary)]')
    expect(getColorClass('text-2xl', 'text')).toBe('')
  })

  it('al fijar reemplaza token Y hex, sin tocar el tamaño', () => {
    const out = setColorClass('text-2xl text-[#ff0055]', 'text', 'text-primary')
    expect(out).toBe('text-2xl text-primary')
    const back = setColorClass(out, 'text', 'text-[#0af]')
    expect(back).toBe('text-2xl text-[#0af]')
  })

  it('hex normalizado para el input type=color', () => {
    expect(colorClassHex('text-[#0af]')).toBe('#00aaff')
    expect(colorClassHex('bg-[#ff0055]')).toBe('#ff0055')
    expect(colorClassHex('bg-primary')).toBeNull()
    expect(colorClassHex('bg-[var(--color-primary)]')).toBeNull()
  })
})
