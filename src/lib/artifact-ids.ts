// DIRECCIONES ESTABLES del artefacto HTML: `data-id` en cada elemento visual.
//
// Es lo que hace posible la edición QUIRÚRGICA (```eb-patch```): el agente dice "cambia el
// nodo a17" y tanto el preview como el editor y el server resuelven `[data-id="a17"]` y
// reemplazan ese subárbol. Sin ids estables no hay dirección y todo cambio obliga a
// re-emitir el artefacto entero (lo que hacíamos hasta 2026-07-25: 40 KB de entrada + 40 KB
// de salida para mover un texto, y deriva en cada reescritura).
//
// Se siembran AL PERSISTIR (server), nunca los escribe el agente: el modelo los duplica,
// los omite o los renumera, y encarece cada nodo. Tampoco se regenera el HTML con
// htmlToDoc→docToHtml del canvas-editor.
//
// ⚠️ Ese último motivo CAMBIÓ a medias el 2026-08-27. El round-trip del canvas ya no se
// come el CSS propio, los <script> ni el `<body class>` — ahora viajan en `Doc.shell`
// (ver `packages/canvas-editor/src/model.ts`), y fue justo esa pérdida la que hizo
// desaparecer el fondo de una landing en una demo. Pero el server SIGUE sin usar ese
// camino, y con razón: `docToHtml` REESTRUCTURA el documento (envuelve el contenido en
// `<section data-artboard-id>`), así que un <script> que dependa de `body > .foo` o de
// `document.body.firstElementChild` se rompe igual. Preservar no es lo mismo que
// garantizar que siga funcionando. Estampar los ids con DOM directo no toca la forma.
//
// El parseo es por DOM (jsdom en server, DOMParser en browser) — mismo patrón `ParseOpts`
// que packages/canvas-editor/src/serialize.ts, y `elToNode` de ese paquete YA respeta los
// `data-id` que vengan en el HTML, así que el editor hereda las direcciones gratis.

export interface ParseOpts {
  /** Instancia de DOMParser (jsdom en el server; global en el browser). */
  parser?: { parseFromString(s: string, t: string): Document };
}

function getParser(opts?: ParseOpts): { parseFromString(s: string, t: string): Document } {
  if (opts?.parser) return opts.parser;
  if (typeof DOMParser !== "undefined") return new DOMParser();
  throw new Error("artifact-ids: sin DOMParser — pasa opts.parser (jsdom) en el server");
}

// Elementos que NO reciben id: no son direccionables (no se ven) y estamparlos solo
// ensuciaría el HTML publicado.
const SKIP = new Set(["script", "style", "link", "meta", "br", "title", "template", "head"]);

const ID_RE = /^a(\d+)$/;

/**
 * Estampa `data-id` en los elementos visuales que no lo tengan. IDEMPOTENTE:
 * `stampIds(stampIds(h)) === stampIds(h)`.
 *
 * - Nunca reasigna un id existente ni reusa su número (el contador arranca en el máximo
 *   ya presente) → las direcciones sobreviven a versiones sucesivas del artefacto.
 * - Los DUPLICADOS sí se re-estampan: dos elementos con el mismo id no son direccionables,
 *   y pasa en cuanto el agente copia un bloque para "añadir otra tarjeta".
 * - No entra en `<script>`/`<template>`: su contenido es texto, no markup vivo.
 */
export function stampIds(html: string, opts?: ParseOpts): string {
  if (!html?.trim()) return html;
  let dom: Document;
  try {
    dom = getParser(opts).parseFromString(html, "text/html");
  } catch {
    return html; // HTML impresentable → mejor dejarlo intacto que romper el guardado
  }
  const body = dom.body;
  if (!body) return html;

  const seen = new Set<string>();
  let max = 0;
  for (const el of Array.from(body.querySelectorAll("[data-id]"))) {
    const id = el.getAttribute("data-id") || "";
    const m = ID_RE.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }

  for (const el of Array.from(body.querySelectorAll("*"))) {
    const tag = el.tagName.toLowerCase();
    if (SKIP.has(tag)) continue;
    // Dentro de <script>/<template> no hay nodos que direccionar.
    if (el.closest("script, template")) continue;
    const cur = el.getAttribute("data-id");
    if (cur && !seen.has(cur)) {
      seen.add(cur);
      continue;
    }
    const next = `a${++max}`;
    el.setAttribute("data-id", next);
    seen.add(next);
  }

  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)?.[0] ?? "";
  return (doctype ? `${doctype}\n` : "") + dom.documentElement.outerHTML;
}

/** ¿Este HTML ya trae direcciones? Si no, el turno debe pedir re-emisión completa. */
export function hasIds(html: string): boolean {
  return /\sdata-id\s*=\s*["'][^"']+["']/.test(html || "");
}

/**
 * Índice compacto de nodos direccionables — el MAPA que se le da al modelo para que elija
 * el `data-id` sin releer 40 KB con atención. Una línea por nodo con contenido propio:
 *   `a17 div.card — "Plan Pro · $29"`
 * Se limita a `max` entradas: es una ayuda de navegación, no el documento.
 */
export function nodeIndex(html: string, max = 80, opts?: ParseOpts): string {
  if (!html?.trim()) return "";
  let dom: Document;
  try {
    dom = getParser(opts).parseFromString(html, "text/html");
  } catch {
    return "";
  }
  const out: string[] = [];
  for (const el of Array.from(dom.body?.querySelectorAll("[data-id]") ?? [])) {
    if (out.length >= max) break;
    const id = el.getAttribute("data-id")!;
    const tag = el.tagName.toLowerCase();
    // Primera clase significativa (la lista completa de utilidades Tailwind sería ruido).
    const cls = (el.getAttribute("class") || "").split(/\s+/).filter(Boolean)[0];
    const text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
    // Solo nodos con algo que identificarlos; un <div> vacío no ayuda a elegir.
    if (!text && !cls) continue;
    out.push(`${id} ${tag}${cls ? `.${cls}` : ""}${text ? ` — "${text}"` : ""}`);
  }
  return out.join("\n");
}
