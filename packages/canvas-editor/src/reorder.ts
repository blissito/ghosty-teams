// Autolayout drag-reorder with auto-snap. Dragging a node hit-tests the DOM to
// find the container under the cursor, computes the nearest insertion slot along
// the container's main axis (row → x, column/flow → y), draws a snap indicator,
// and commits an immutable moveNode on drop. Imperative on purpose (no React
// re-render per mouse move) for smoothness.

import { cloneNode } from './model'
import type { EditorStore } from './store'

interface Pending {
  artboardId: string
  parentId: string | null
  index: number
}

export class ReorderController {
  private draggedId: string | null = null
  private draggedEl: HTMLElement | null = null
  private indicator: HTMLDivElement | null = null
  private pending: Pending | null = null
  private startX = 0
  private startY = 0
  private alt = false
  active = false

  constructor(
    private store: EditorStore,
    private getViewport: () => HTMLElement | null,
  ) {}

  /** Arm a potential drag from a node press (does not start until threshold).
   *  `alt` = clone-on-drop (Option/Alt-drag duplicate). */
  arm(nodeId: string, clientX: number, clientY: number, alt = false) {
    this.draggedId = nodeId
    this.startX = clientX
    this.startY = clientY
    this.alt = alt
    this.active = false
  }

  isArmed() {
    return this.draggedId != null
  }

  move(clientX: number, clientY: number): boolean {
    if (!this.draggedId) return false
    if (!this.active) {
      if (Math.abs(clientX - this.startX) + Math.abs(clientY - this.startY) < 5) return false
      this.begin()
    }
    this.updateTarget(clientX, clientY)
    return true
  }

  private begin() {
    const vp = this.getViewport()
    if (!vp || !this.draggedId) return
    this.draggedEl = vp.querySelector(`[data-id="${cssEscape(this.draggedId)}"]`) as HTMLElement | null
    if (this.draggedEl) this.draggedEl.style.opacity = '0.4'
    this.active = true
    this.indicator = document.createElement('div')
    Object.assign(this.indicator.style, {
      position: 'absolute',
      background: '#8b5cf6',
      borderRadius: '2px',
      pointerEvents: 'none',
      zIndex: '9999',
      boxShadow: '0 0 6px #8b5cf6',
    })
    vp.appendChild(this.indicator)
  }

  private updateTarget(clientX: number, clientY: number) {
    const vp = this.getViewport()
    if (!vp || !this.draggedEl || !this.indicator) return

    // hide dragged element from hit-test so we can see what's underneath
    const prevPE = this.draggedEl.style.pointerEvents
    this.draggedEl.style.pointerEvents = 'none'
    const under = document.elementFromPoint(clientX, clientY)
    this.draggedEl.style.pointerEvents = prevPE

    const container = this.resolveContainer(under)
    if (!container) {
      this.pending = null
      this.indicator.style.display = 'none'
      return
    }
    const artboardEl = container.closest('[data-artboard-id]') as HTMLElement | null
    if (!artboardEl) {
      this.pending = null
      this.indicator.style.display = 'none'
      return
    }
    const artboardId = artboardEl.getAttribute('data-artboard-id')!
    const parentId = container.hasAttribute('data-id') ? container.getAttribute('data-id') : null

    const kids = directIdChildren(container).filter((c) => c !== this.draggedEl)
    const cs = getComputedStyle(container)
    const horizontal = cs.display.includes('flex') && cs.flexDirection.startsWith('row')

    let index = kids.length
    for (let i = 0; i < kids.length; i++) {
      const r = kids[i].getBoundingClientRect()
      const mid = horizontal ? r.left + r.width / 2 : r.top + r.height / 2
      if ((horizontal ? clientX : clientY) < mid) {
        index = i
        break
      }
    }

    this.pending = { artboardId, parentId, index }
    this.drawIndicator(container, kids, index, horizontal, vp)
  }

  private drawIndicator(container: Element, kids: HTMLElement[], index: number, horizontal: boolean, vp: HTMLElement) {
    if (!this.indicator) return
    const vr = vp.getBoundingClientRect()
    const cr = container.getBoundingClientRect()
    const THICK = 3
    let pos: number
    if (kids.length === 0) {
      pos = horizontal ? cr.left + 4 : cr.top + 4
    } else if (index <= 0) {
      const r = kids[0].getBoundingClientRect()
      pos = horizontal ? r.left - 2 : r.top - 2
    } else if (index >= kids.length) {
      const r = kids[kids.length - 1].getBoundingClientRect()
      pos = horizontal ? r.right - 1 : r.bottom - 1
    } else {
      const a = kids[index - 1].getBoundingClientRect()
      const b = kids[index].getBoundingClientRect()
      pos = horizontal ? (a.right + b.left) / 2 : (a.bottom + b.top) / 2
    }
    const s = this.indicator.style
    s.display = 'block'
    if (horizontal) {
      s.left = `${pos - vr.left - THICK / 2}px`
      s.top = `${cr.top - vr.top}px`
      s.width = `${THICK}px`
      s.height = `${cr.height}px`
    } else {
      s.left = `${cr.left - vr.left}px`
      s.top = `${pos - vr.top - THICK / 2}px`
      s.width = `${cr.width}px`
      s.height = `${THICK}px`
    }
  }

  /** Resolve which container the cursor is over (sibling-insert semantics). */
  private resolveContainer(el: Element | null): Element | null {
    let hovered = el?.closest('[data-id],[data-artboard-id]') ?? null
    // climb out of the dragged subtree
    while (hovered && this.draggedEl && this.draggedEl.contains(hovered)) {
      hovered = hovered.parentElement?.closest('[data-id],[data-artboard-id]') ?? null
    }
    if (!hovered) return null
    // if hovered has id-children, it's a container; else insert among its parent's children
    if (hovered.hasAttribute('data-artboard-id') || directIdChildren(hovered).length > 0) return hovered
    const parent = hovered.parentElement?.closest('[data-id],[data-artboard-id]') ?? null
    return parent && (!this.draggedEl || !this.draggedEl.contains(parent)) ? parent : hovered
  }

  drop() {
    if (this.active && this.draggedId && this.pending) {
      if (this.alt) {
        const original = this.store.findNodePublic(this.draggedId)
        if (original) this.store.insertNode(this.pending, cloneNode(original))
      } else {
        this.store.moveNode(this.draggedId, this.pending)
      }
    }
    this.reset()
  }

  cancel() {
    this.reset()
  }

  private reset() {
    if (this.draggedEl) this.draggedEl.style.opacity = ''
    if (this.indicator) this.indicator.remove()
    this.indicator = null
    this.draggedEl = null
    this.draggedId = null
    this.pending = null
    this.active = false
  }
}

function directIdChildren(el: Element): HTMLElement[] {
  const out: HTMLElement[] = []
  for (const child of Array.from(el.children)) {
    if (child.hasAttribute('data-id')) out.push(child as HTMLElement)
  }
  return out
}

function cssEscape(s: string): string {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s)
  return s.replace(/["\\]/g, '\\$&')
}
