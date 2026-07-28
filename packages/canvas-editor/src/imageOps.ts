// Operaciones de imagen y fondo — portadas del editor clásico de Denik
// (`EditorRightSidebar.tsx`, panel "Imagen y fondo"). El Inspector nuevo sólo
// sabía editar `<img>.src`, así que un hero cuya foto es un `background-image`
// de un `<div>` quedaba INEDITABLE: no había manera de cambiarla ni de quitarla.
//
// Todo se escribe como declaración INLINE (igual que cssProps.ts) para ganarle
// tanto a las clases Tailwind como al `<style>` del artefacto.

import { genId, locateNode, type Doc, type Node, type NodeId } from './model'
import { nodeEl } from './cssProps'
import { classList, removeClass } from './tailwindClasses'
import type { EditorStore } from './store'

/** Las declaraciones que juntas forman "la imagen de fondo" de un nodo. */
const BG_PROPS = ['background-image', 'background-size', 'background-position', 'background-repeat'] as const

/** Saca la URL de un valor CSS `url("…")`. `none` y los gradientes → null. */
export function urlFromCssValue(value: string | undefined | null): string | null {
  if (!value) return null
  const m = /url\((['"]?)(.*?)\1\)/.exec(value)
  return m?.[2] || null
}

/** Valor de una declaración dentro del `style` inline de un nodo. */
export function inlineDecl(style: string | undefined, prop: string): string | null {
  if (!style) return null
  for (const decl of style.split(';')) {
    const i = decl.indexOf(':')
    if (i < 0) continue
    if (decl.slice(0, i).trim().toLowerCase() === prop) return decl.slice(i + 1).trim()
  }
  return null
}

/**
 * URL de fondo EFECTIVA del nodo: primero la declaración inline, y si no, la que
 * venga de una clase o del `<style>` del artefacto (leída del DOM vivo). Sin el
 * fallback al computed, un hero generado por la IA aparecía "sin fondo".
 */
export function backgroundUrl(node: Node): string | null {
  const inline = urlFromCssValue(inlineDecl(node.style, 'background-image'))
  if (inline) return inline
  const el = nodeEl(node.id)
  if (!el) return null
  return urlFromCssValue(getComputedStyle(el).backgroundImage)
}

/** Pone (o reemplaza) la imagen de fondo, con cover/center para que no se repita. */
export function setBackground(store: EditorStore, id: NodeId, url: string) {
  store.setNodeStyleProps(id, {
    'background-image': `url("${url}")`,
    'background-size': 'cover',
    'background-position': 'center',
    'background-repeat': 'no-repeat',
  })
}

/**
 * Quita el fondo. Escribe `none` en vez de borrar la declaración cuando la
 * imagen venía de una CLASE: borrar el inline devolvería el control al CSS del
 * autor y la foto reaparecería.
 */
export function clearBackground(store: EditorStore, node: Node) {
  const fromClass = !inlineDecl(node.style, 'background-image') && !!backgroundUrl(node)
  const decls: Record<string, string | null> = {}
  for (const p of BG_PROPS) decls[p] = null
  if (fromClass) decls['background-image'] = 'none'
  store.setNodeStyleProps(node.id, decls)
  // Y si el fondo lo ponía una utility (bg-[url(...)]), fuera la clase.
  const bgClass = classList(node.cls).find((c) => /^bg-\[url\(/.test(c))
  if (bgClass) store.setNodeClasses(node.id, removeClass(node.cls, bgClass))
}

// --- navegación por ancestros --------------------------------------------

/** El padre del nodo, o null si cuelga directo del artboard. */
export function parentOf(doc: Doc, id: NodeId): Node | null {
  const loc = locateNode(doc, id)
  if (!loc?.parentId) return null
  return findIn(doc, loc.parentId)
}

/** Cadena de ancestros, del más cercano al más lejano. */
export function ancestorsOf(doc: Doc, id: NodeId): Node[] {
  const out: Node[] = []
  let cur: NodeId | null = id
  // Tope defensivo: un doc corrupto con un ciclo colgaría el inspector.
  for (let i = 0; i < 64 && cur; i++) {
    const p = parentOf(doc, cur)
    if (!p) break
    out.push(p)
    cur = p.id
  }
  return out
}

function findIn(doc: Doc, id: NodeId): Node | null {
  for (const ab of doc.artboards) {
    const stack = [...ab.nodes]
    while (stack.length) {
      const n = stack.pop()!
      if (n.id === id) return n
      stack.push(...n.children)
    }
  }
  return null
}

/**
 * El ancestro más cercano que SÍ tiene imagen de fondo, o null.
 *
 * En un hero generado la foto casi nunca está en el elemento que uno clica: el
 * clic cae en el overlay o en el texto, y el `background-image` lo carga un
 * `div` más arriba. Esto permite ofrecer un salto DIRECTO a ese elemento en vez
 * de un "subir un nivel" a ciegas, que obliga a adivinar cuántas veces pulsar.
 */
export function nearestBackgroundAncestor(doc: Doc, id: NodeId): Node | null {
  for (const a of ancestorsOf(doc, id)) {
    if (backgroundUrl(a)) return a
  }
  return null
}

/**
 * La `<img>` que este contenedor está mostrando, si hay exactamente una en su
 * subárbol.
 *
 * Existe por un fallo real: seleccionar la tarjeta (un `div` con una `<img>`
 * dentro), pulsar "Reemplazar" y ponerle un `background-image` NO reemplaza
 * nada — la `<img>` original sigue ahí, dibujada encima o debajo del nuevo
 * fondo. En la vista previa parecía correcto y al hacer scroll aparecía la foto
 * vieja abajo. Con esto, "reemplazar" sobre ese contenedor edita el `src` de la
 * `<img>` que ya existe, que es lo que el usuario está viendo y creyó tocar.
 *
 * Sólo una: con dos o más (una galería) no hay "la imagen" que reemplazar, y
 * elegir por él sería adivinar.
 */
export function soleImageDescendant(node: Node): Node | null {
  const found: Node[] = []
  const dig = (n: Node) => {
    for (const c of n.children) {
      if (c.tag === 'img') found.push(c)
      dig(c)
    }
  }
  dig(node)
  return found.length === 1 ? found[0] : null
}

/**
 * Contexto de SOLO LECTURA para un refine por-nodo: dónde vive el nodo y qué
 * tiene al lado, sin darle al modelo el HTML de los vecinos (ver
 * `RefineNodeInput.context`).
 */
export function refineContext(doc: Doc, id: NodeId): string {
  const chain = ancestorsOf(doc, id)
  if (!chain.length) return ''
  const lines: string[] = []
  // De fuera hacia dentro se lee como una ruta: section > div > h2.
  const crumb = [...chain].reverse().map((a) => `<${a.tag}${a.cls ? ` class="${a.cls}"` : ''}>`)
  lines.push(`Ancestros (de fuera hacia dentro): ${crumb.join(' > ')}`)

  const parent = chain[0]
  const siblings = parent.children.filter((c) => c.id !== id)
  if (siblings.length) {
    lines.push(
      `Hermanos (NO los edites, sólo para que combines con ellos): ${siblings
        .map((s) => `<${s.tag}${s.cls ? ` class="${s.cls}"` : ''}>`)
        .join(', ')}`,
    )
  }
  const geo = measureContext(id)
  if (geo) lines.push(geo)
  return lines.join('\n')
}

/**
 * Medidas REALES del nodo y sus hermanos, leídas del lienzo.
 *
 * POR QUÉ EXISTE: el modelo sólo ve HTML y clases, y hay defectos que no están
 * ahí. Dos badges `absolute` que se encabalgan no se deducen del marcado — dependen
 * del ancho real del texto y de la caja que los contiene. Pedirle "arregla el
 * solape" a ciegas es pedirle que adivine, y por eso fallaba una y otra vez.
 *
 * Con esto recibe el dato ("te solapas 62px con el hermano X") y puede corregir.
 * Las medidas se dividen por la escala de la cámara para reportar px de layout,
 * no px de pantalla: `offsetWidth` no lo afecta el `transform` del canvas y
 * `getBoundingClientRect` sí, así que su cociente ES el zoom.
 */
export function measureContext(id: NodeId): string {
  if (typeof document === 'undefined') return ''
  const el = document.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)
  if (!el) return ''
  const scale = el.getBoundingClientRect().width / (el.offsetWidth || 1) || 1
  const box = (n: HTMLElement) => {
    const r = n.getBoundingClientRect()
    return { l: r.left / scale, t: r.top / scale, r: r.right / scale, b: r.bottom / scale }
  }
  const me = box(el)
  const round = (n: number) => Math.round(n)
  const lines = [
    `Medidas reales en el lienzo (px): este nodo ${round(me.r - me.l)}×${round(me.b - me.t)}.`,
  ]

  const overlaps: string[] = []
  for (const sib of Array.from(el.parentElement?.children ?? [])) {
    if (sib === el || !(sib instanceof HTMLElement)) continue
    const sid = sib.getAttribute('data-id')
    if (!sid) continue
    const s = box(sib)
    const dx = Math.min(me.r, s.r) - Math.max(me.l, s.l)
    const dy = Math.min(me.b, s.b) - Math.max(me.t, s.t)
    if (dx > 1 && dy > 1) {
      overlaps.push(`<${sib.tagName.toLowerCase()} data-id="${sid}"> (${round(dx)}px × ${round(dy)}px)`)
    }
  }
  if (overlaps.length) {
    lines.push(
      `DEFECTO DETECTADO — este nodo SE SOLAPA con: ${overlaps.join(', ')}. ` +
        `Corrígelo: separa las cajas, cambia su posición o su tamaño. NO basta con cambiar colores.`,
    )
  }

  // Solapes DENTRO del nodo: si el usuario seleccionó el contenedor, el defecto
  // está entre sus descendientes, no entre sus hermanos. Sólo se miran los
  // posicionados — el flujo normal no se encabalga, y compararlo todo contra todo
  // llenaría el contexto de ruido (un texto SIEMPRE se solapa con su div padre).
  // Se miran TODOS los descendientes, no sólo los `absolute`: un solape también
  // sale de un margen negativo, un `transform` o una caja que desborda, y filtrar
  // por posición dejaba fuera el caso real (dos badges encimados que el modelo
  // "reparó" sin separar, porque nadie le dijo que seguían encimados).
  // Los pares anidados se excluyen abajo — un texto SIEMPRE cae dentro de su div.
  const placed = Array.from(el.querySelectorAll<HTMLElement>('[data-id]'))
  const inner: string[] = []
  for (let i = 0; i < placed.length && inner.length < 4; i++) {
    for (let j = i + 1; j < placed.length && inner.length < 4; j++) {
      if (placed[i].contains(placed[j]) || placed[j].contains(placed[i])) continue
      const a = box(placed[i])
      const b = box(placed[j])
      const dx = Math.min(a.r, b.r) - Math.max(a.l, b.l)
      const dy = Math.min(a.b, b.b) - Math.max(a.t, b.t)
      if (dx > 1 && dy > 1) {
        inner.push(
          `data-id="${placed[i].getAttribute('data-id')}" con data-id="${placed[j].getAttribute('data-id')}" (${round(dx)}px × ${round(dy)}px)`,
        )
      }
    }
  }
  if (inner.length) {
    lines.push(
      `DEFECTO DETECTADO — dentro de este nodo hay elementos encimados: ${inner.join('; ')}. ` +
        `Reubícalos para que no se toquen (cambia su anclaje, su offset o apílalos con gap).`,
    )
  }
  return lines.join('\n')
}

// --- escapes a la directiva de layout del generador -----------------------

/** Clases que encajonan el contenido y hay que quitar para un full-bleed. */
const CONSTRAINING = /^(container|mx-auto|max-w-|(sm:|md:|lg:|xl:)?(px|pl|pr)-)/

/**
 * "Ancho completo": el SDK envuelve cada sección en `max-w-7xl mx-auto px-4`, así
 * que una imagen nunca llega a los bordes por más que la estires. Esto quita esas
 * restricciones en el nodo y en TODOS sus ancestros, y si el nodo vive en un grid
 * lo hace ocupar la fila entera. Es deshacible con ⌘Z (una sola entrada de undo
 * no: son varias ediciones — documentado a propósito).
 */
export function makeFullBleed(store: EditorStore, doc: Doc, id: NodeId) {
  const node = findIn(doc, id)
  if (!node) return
  for (const n of [node, ...ancestorsOf(doc, id)]) {
    const keep = classList(n.cls).filter((c) => !CONSTRAINING.test(c))
    if (keep.length !== classList(n.cls).length) store.setNodeClasses(n.id, keep.join(' '))
    store.setNodeStyleProps(n.id, { 'max-width': 'none', 'padding-left': '0px', 'padding-right': '0px' })
  }
  store.setNodeStyleProps(id, { width: '100%', 'grid-column': '1 / -1' })
}

/**
 * "Foto de fondo": manda la foto de un `<img>` al fondo de la sección que lo
 * contiene, con overlay para que el texto encima siga legible.
 *
 * El `<img>` original se OCULTA (no se borra): así el cambio se revierte desde el
 * ojito de la capa. Borrarlo dejaba al usuario sin vuelta atrás si el resultado
 * no le gustaba.
 *
 * Devuelve un mensaje de error, o null si funcionó.
 */
export function makeHeroBackground(store: EditorStore, doc: Doc, id: NodeId): string | null {
  const node = findIn(doc, id)
  if (!node) return 'No encuentro el nodo seleccionado.'
  if (node.tag !== 'img' || !node.src) return 'Selecciona una imagen (<img>) para mandarla al fondo.'

  const ancestors = ancestorsOf(doc, id)
  // La sección contenedora; si la IA no usó <section>, el ancestro más lejano.
  const target = ancestors.find((a) => a.tag === 'section') ?? ancestors[ancestors.length - 1]
  if (!target) return 'Esta imagen no está dentro de un contenedor al que ponerle fondo.'

  setBackground(store, target.id, node.src)
  store.setNodeStyleProps(target.id, { position: 'relative', 'background-color': null })
  // Overlay: el mismo patrón que pide el prompt del SDK para texto sobre imagen.
  store.insertNode(
    { artboardId: locateNode(doc, target.id)?.artboardId ?? doc.artboards[0].id, parentId: target.id, index: 0 },
    {
      id: genId('ov'),
      tag: 'div',
      cls: 'absolute inset-0 bg-gradient-to-t from-primary/70 via-primary/20 to-transparent',
      style: 'pointer-events:none',
      children: [],
    },
  )
  store.updateNode(id, { hidden: true })
  // insertNode deja seleccionado el overlay; devolvemos el foco a la sección,
  // que es lo que el usuario acaba de convertir en hero.
  store.select(target.id)
  return null
}
