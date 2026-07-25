// APLICACIÓN de patches quirúrgicos sobre el HTML del artefacto.
//
// Se parchea por DOM sobre el documento ACTUAL (`querySelector('[data-id=…]')` +
// `outerHTML = …`), NO reconstruyendo con htmlToDoc→docToHtml del canvas-editor: ese camino
// regenera el documento entero (emite su propio <head>, normaliza el <style> y envuelve el
// body en un artboard) y se lleva por delante los <script> del artefacto — una calculadora o
// un juego dejarían de funcionar. Aquí todo lo que está fuera del subárbol parcheado
// sobrevive: scripts, estilos, comentarios y estructura.
//
// Es la AUTORIDAD del patch: el cliente aplica en vivo para que se vea, pero lo que se
// persiste es lo que decide esta función, y lo que no aplica se reporta (nunca en silencio).
import type { EbPatch } from "./ebdoc";
import { type ParseOpts, stampIds } from "./artifact-ids";

export type PatchFailure = {
  nodeId: string;
  reason: "missing" | "unparseable" | "root" | "empty";
};

export type PatchResult = {
  html: string; // el documento resultante (= entrada si no aplicó ninguno)
  applied: string[]; // nodeIds aplicados
  failed: PatchFailure[]; // los que no, con el motivo
};

function getParser(opts?: ParseOpts): { parseFromString(s: string, t: string): Document } {
  if (opts?.parser) return opts.parser;
  if (typeof DOMParser !== "undefined") return new DOMParser();
  throw new Error("applyPatches: sin DOMParser — pasa opts.parser (jsdom) en el server");
}

export function applyPatches(html: string, patches: EbPatch[], opts?: ParseOpts): PatchResult {
  const applied: string[] = [];
  const failed: PatchFailure[] = [];
  const usable = patches.filter((p) => p.closed && p.nodeId && (p.op === "remove" || p.remove || p.html.trim()));
  if (!html?.trim() || !usable.length) {
    return { html, applied, failed: patches.filter((p) => !p.closed).map((p) => ({ nodeId: p.nodeId, reason: "empty" as const })) };
  }

  const parser = getParser(opts);
  let dom: Document;
  try {
    dom = parser.parseFromString(html, "text/html");
  } catch {
    return { html, applied, failed: usable.map((p) => ({ nodeId: p.nodeId, reason: "unparseable" as const })) };
  }

  for (const p of usable) {
    const el = dom.querySelector(`[data-id="${p.nodeId.replace(/"/g, '\\"')}"]`);
    if (!el) {
      failed.push({ nodeId: p.nodeId, reason: "missing" });
      continue;
    }
    // `outerHTML` exige padre: un patch al <body>/<html> no es quirúrgico, es un rediseño
    // → que se re-emita el artefacto completo.
    // replace/remove necesitan padre (outerHTML/remove sobre <body> no es quirúrgico);
    // insert sí puede colgar DENTRO del body.
    const needsParent = p.op !== "insert" || p.pos === "before" || p.pos === "after";
    if (needsParent && (!el.parentNode || el === dom.body || el === dom.documentElement)) {
      failed.push({ nodeId: p.nodeId, reason: "root" });
      continue;
    }
    // Borrado explícito: se quita el nodo y sus hermanos ni se enteran.
    if (p.op === "remove" || p.remove) {
      el.remove();
      applied.push(p.nodeId);
      continue;
    }
    // El bloque debe traer AL MENOS un elemento (y no prosa del modelo ni markup a medias).
    // VARIOS hermanos son válidos: pedirle "añade dos tarjetas" produce dos <div> en un mismo
    // bloque, y exigir uno solo lo mandaba a `unparseable` (reportado 2026-07-25).
    let fragEls: Element[] = [];
    try {
      const frag = parser.parseFromString(`<body>${p.html}</body>`, "text/html");
      fragEls = Array.from(frag.body?.children ?? []);
    } catch {
      fragEls = [];
    }
    if (!fragEls.length) {
      failed.push({ nodeId: p.nodeId, reason: "unparseable" });
      continue;
    }
    const fragEl = fragEls[0];
    // El id de la CABECERA manda aunque el modelo lo haya omitido o cambiado.
    if (p.op === "insert") {
      // El id de la cabecera es el ANCLA, no los nodos nuevos: estos no tienen dirección
      // todavía (se la pone stampIds al final).
      for (const e of fragEls) e.removeAttribute("data-id");
      if (p.pos === "prepend") el.prepend(...fragEls);
      else if (p.pos === "before") el.before(...fragEls);
      else if (p.pos === "after") el.after(...fragEls);
      else el.append(...fragEls);
      applied.push(p.nodeId);
      continue;
    }
    fragEl.setAttribute("data-id", p.nodeId);
    el.replaceWith(...fragEls); // reemplazar por VARIOS nodos también es legítimo
    applied.push(p.nodeId);
  }

  if (!applied.length) return { html, applied, failed };

  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)?.[0] ?? "";
  const out = (doctype ? `${doctype}\n` : "") + dom.documentElement.outerHTML;
  // Los nodos NUEVOS que trae el patch no tienen dirección todavía → re-estampar para que
  // el siguiente turno también pueda parchearlos.
  return { html: stampIds(out, opts), applied, failed };
}
