import { describe, expect, it } from "vitest";
import { bubbleWithoutEbDoc, stripOrphanPatch } from "./ebdoc";

// Cuerpo REAL de producción (msg 1093, 2026-07-29): el fence de apertura se perdió por
// el camino y su contenido acabó en la burbuja del chat.
const REAL =
  "eb-patch n3\n**FELIPE CERON MARTINEZ**, personalidad que acredito con el testimonio " +
  "del Instrumento Notarial número 5569.\n```\n\n\n\nListo: **5569** aplicado.";

describe("cabecera de patch huérfana", () => {
  it("no deja las tripas del protocolo en la burbuja", () => {
    const out = stripOrphanPatch(REAL);
    expect(out).not.toContain("eb-patch");
    expect(out).not.toContain("FELIPE CERON");
    expect(out).toContain("Listo:");
  });

  it("el bubble tampoco", () => {
    const out = bubbleWithoutEbDoc(REAL);
    expect(out).not.toContain("eb-patch");
    expect(out).not.toContain("FELIPE CERON");
  });

  it("no toca un texto que sólo MENCIONA el protocolo", () => {
    const prosa = "Para eso uso un bloque eb-patch con el id del nodo.";
    expect(stripOrphanPatch(prosa)).toBe(prosa);
  });

  it("no toca un patch BIEN formado (ése lo maneja stripEbPatches)", () => {
    const ok = "```eb-patch n3\n<div>x</div>\n```\n\nListo.";
    expect(stripOrphanPatch(ok)).toBe(ok);
  });

  it("huérfano sin cierre: se lleva hasta el final", () => {
    const out = stripOrphanPatch("eb-patch n7\ncontenido a medias");
    expect(out.trim()).toBe("");
  });
});
