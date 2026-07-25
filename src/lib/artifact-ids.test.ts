// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { hasIds, nodeIndex, stampIds } from "./artifact-ids";

const DOC = (body: string) => `<!DOCTYPE html>
<html><head><title>t</title><style>.x{color:red}</style></head><body>${body}</body></html>`;

describe("stampIds", () => {
  it("es idempotente", () => {
    const once = stampIds(DOC(`<div><p>hola</p></div>`));
    expect(stampIds(once)).toBe(once);
  });

  it("estampa los elementos visuales", () => {
    const out = stampIds(DOC(`<div><p>hola</p></div>`));
    expect(out).toMatch(/<div data-id="a1"/);
    expect(out).toMatch(/<p data-id="a2"/);
  });

  it("preserva los ids existentes y NO reusa sus números", () => {
    const out = stampIds(DOC(`<div data-id="a9"><p>hola</p></div>`));
    expect(out).toMatch(/<div data-id="a9"/);
    expect(out).toMatch(/<p data-id="a10"/);
  });

  it("re-estampa duplicados (dos nodos con el mismo id no son direccionables)", () => {
    const out = stampIds(DOC(`<div data-id="a1">uno</div><div data-id="a1">dos</div>`));
    const ids = [...out.matchAll(/data-id="(a\d+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("no toca el contenido de <script> ni <style>", () => {
    const script = `<script>if (1 < 2) { window.x = "<div>" }</script>`;
    const out = stampIds(DOC(`<div>hola</div>${script}`));
    expect(out).toContain(script);
    expect(out).not.toMatch(/<script data-id=/);
  });

  it("conserva el doctype y no revienta con HTML vacío", () => {
    expect(stampIds(DOC(`<div>x</div>`))).toMatch(/^<!DOCTYPE html>/i);
    expect(stampIds("")).toBe("");
  });
});

describe("hasIds", () => {
  it("distingue artefacto estampado de uno viejo", () => {
    expect(hasIds(`<div data-id="a1">x</div>`)).toBe(true);
    expect(hasIds(`<div class="card">x</div>`)).toBe(false);
  });
});

describe("nodeIndex", () => {
  it("lista id, tag, primera clase y un extracto del texto", () => {
    const html = stampIds(DOC(`<div class="card p-4">Plan Pro · $29</div>`));
    expect(nodeIndex(html)).toMatch(/^a1 div\.card — "Plan Pro · \$29"$/m);
  });

  it("respeta el tope de entradas", () => {
    const items = Array.from({ length: 20 }, (_, i) => `<p>linea ${i}</p>`).join("");
    expect(nodeIndex(stampIds(DOC(items)), 5).split("\n")).toHaveLength(5);
  });

  it("omite los nodos sin nada que los identifique", () => {
    expect(nodeIndex(stampIds(DOC(`<div></div>`)))).toBe("");
  });
});
