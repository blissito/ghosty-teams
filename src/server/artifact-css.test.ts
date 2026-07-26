import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { bakeTailwind } from "./artifact-css.server";
import { TAILWIND_INDEX_CSS } from "./tailwind-index-css";

// La hoja base está vendorizada (ver tailwind-index-css.ts). Este test es el aviso de que
// se quedó atrás al subir de versión: sin él, el artefacto se hornearía con el CSS viejo
// en silencio. Se salta donde no hay node_modules (CI con deps podadas).
describe("hoja base vendorizada", () => {
  const p = "node_modules/tailwindcss/index.css";
  it.skipIf(!fs.existsSync(p))("coincide con la de node_modules", () => {
    expect(TAILWIND_INDEX_CSS).toBe(fs.readFileSync(p, "utf8"));
  });
});

const doc = (body: string, extraHead = "") =>
  `<!doctype html><html><head><script src="https://cdn.tailwindcss.com"></script>${extraHead}</head>` +
  `<body>${body}</body></html>`;

describe("bakeTailwind", () => {
  it("hornea el CSS de las clases usadas y deja el CDN como respaldo", async () => {
    const out = await bakeTailwind(doc(`<div class="flex gap-4 rounded-xl p-6">hola</div>`));
    expect(out).toContain("<style gt-baked-tw>");
    // Las utilidades del documento salen compiladas…
    expect(out).toMatch(/\.flex\s*\{/);
    expect(out).toMatch(/\.p-6\s*\{/);
    // …y el CDN sigue ahí para las clases que el artefacto arme en runtime.
    expect(out).toContain("cdn.tailwindcss.com");
    // El <style> va ANTES del CDN → el primer paint ya sale estilado.
    expect(out.indexOf("gt-baked-tw")).toBeLessThan(out.indexOf("cdn.tailwindcss.com"));
  });

  it("re-hornea desde cero: un patch nuevo no se queda sin CSS", async () => {
    const first = await bakeTailwind(doc(`<div class="flex">a</div>`));
    expect(first).not.toMatch(/\.grid\s*\{/);
    // Simula el publish posterior a un ```eb-patch```: HTML ya horneado + un nodo con
    // clases que no existían.
    const patched = first.replace("<div class=\"flex\">a</div>", '<div class="grid">a</div>');
    const second = await bakeTailwind(patched);
    expect(second).toMatch(/\.grid\s*\{/);
    // Sin acumular bloques horneados de versiones anteriores.
    expect(second.match(/gt-baked-tw/g)?.length).toBe(1);
  });

  it("no toca un artefacto que no usa el CDN", async () => {
    const html = `<!doctype html><html><body><p>sin tailwind</p></body></html>`;
    expect(await bakeTailwind(html)).toBe(html);
  });
});
