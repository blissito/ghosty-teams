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

describe("varios fences en UN mensaje", () => {
  it("no deja crudo el segundo artefacto (el agente se corrige y re-emite)", () => {
    const body = "Aquí va.\n\n```eb-artifact\n<h1>uno</h1>\n```\n\nMejor así:\n\n```eb-artifact\n<h1>dos</h1>\n```\n\nListo.";
    const out = bubbleWithoutEbDoc(body);
    expect(out).not.toContain("```");
    expect(out).not.toContain("eb-artifact");
    expect(out).not.toContain("<h1>");
    expect(out).toContain("Mejor así");
  });

  it("mientras el SEGUNDO streamea, la burbuja dice el estado una sola vez", () => {
    const body = "Aquí va.\n\n```eb-artifact\n<h1>uno</h1>\n```\n\nMejor así:\n\n```eb-artifact\n<!DOCTYPE html>\n<style>\nbody{color:red}\n";
    const out = bubbleWithoutEbDoc(body);
    expect(out).not.toContain("DOCTYPE");
    expect(out.match(/Generando el artefacto/g)?.length).toBe(1);
  });

  it("mezcla doc + hoja en el mismo mensaje: ninguno se cuela", () => {
    const body = "Te dejo los dos:\n\n```eb-doc\n# Contrato\n```\n\ny la hoja:\n\n```eb-sheet\na,b\n1,2\n```";
    const out = bubbleWithoutEbDoc(body);
    expect(out).not.toContain("```");
    expect(out).toContain("y la hoja");
  });
});
