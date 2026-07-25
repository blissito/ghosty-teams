// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { applyPatches } from "./artifact-patch";
import { stampIds } from "./artifact-ids";
import type { EbPatch } from "./ebdoc";

const SCRIPT = `<script>if (1 < 2) { window.x = "<div>" }</script>`;
const STYLE = `<style>@keyframes k{from{opacity:0}}</style>`;
const BASE = stampIds(`<!DOCTYPE html>
<html><head>${STYLE}</head><body>
<section class="grid"><div class="card">Uno</div><div class="card">Dos</div><div class="card">Tres</div></section>
${SCRIPT}
</body></html>`);

const patch = (nodeId: string, html: string): EbPatch => ({ nodeId, html, closed: true });

// Los ids que estampó stampIds sobre BASE: a1 = section, a2..a4 = las tarjetas.
describe("applyPatches", () => {
  it("reemplaza el subárbol y NO toca script ni style", () => {
    const r = applyPatches(BASE, [patch("a3", `<div data-id="a3" class="card">DOS EDITADO</div>`)]);
    expect(r.applied).toEqual(["a3"]);
    expect(r.html).toContain("DOS EDITADO");
    expect(r.html).not.toContain(">Dos<");
    // La razón de existir de este módulo: el artefacto interactivo sobrevive intacto.
    expect(r.html).toContain(SCRIPT);
    expect(r.html).toContain("@keyframes k");
  });

  it("borrar un nodo = re-emitir el padre sin ese hijo", () => {
    const r = applyPatches(BASE, [
      patch("a1", `<section data-id="a1" class="grid"><div data-id="a2" class="card">Uno</div><div data-id="a4" class="card">Tres</div></section>`),
    ]);
    expect(r.applied).toEqual(["a1"]);
    expect(r.html.match(/class="card"/g)).toHaveLength(2);
    expect(r.html).not.toContain(">Dos<");
  });

  it("id inexistente → no aplica, html intacto y motivo reportado", () => {
    const r = applyPatches(BASE, [patch("zz9", `<div data-id="zz9">x</div>`)]);
    expect(r.applied).toEqual([]);
    expect(r.failed).toEqual([{ nodeId: "zz9", reason: "missing" }]);
    expect(r.html).toBe(BASE);
  });

  it("fragmento que no es UN elemento → unparseable, documento intacto", () => {
    const r = applyPatches(BASE, [patch("a3", `Claro, aquí tienes el cambio:`)]);
    expect(r.applied).toEqual([]);
    expect(r.failed[0].reason).toBe("unparseable");
    expect(r.html).toBe(BASE);
  });

  it("fuerza el data-id de la cabecera aunque el modelo lo pierda", () => {
    const r = applyPatches(BASE, [patch("a3", `<div class="card">Sin id</div>`)]);
    expect(r.applied).toEqual(["a3"]);
    // (el orden de atributos lo decide el serializador; lo que importa es que el id esté)
    expect(r.html).toMatch(/<div class="card" data-id="a3">Sin id<\/div>/);
  });

  it("los nodos NUEVOS del patch salen estampados", () => {
    const r = applyPatches(BASE, [
      patch("a3", `<div data-id="a3" class="card"><span>nuevo</span></div>`),
    ]);
    expect(r.applied).toEqual(["a3"]);
    const span = /<span data-id="(a\d+)"/.exec(r.html);
    expect(span).not.toBeNull();
  });

  it("ignora los patches todavía abiertos (streaming a medias)", () => {
    const r = applyPatches(BASE, [{ nodeId: "a3", html: `<div class="ca`, closed: false }]);
    expect(r.applied).toEqual([]);
    expect(r.html).toBe(BASE);
  });

  it("aplica varios patches en una pasada", () => {
    const r = applyPatches(BASE, [
      patch("a2", `<div data-id="a2" class="card">UNO</div>`),
      patch("a4", `<div data-id="a4" class="card">TRES</div>`),
    ]);
    expect(r.applied).toEqual(["a2", "a4"]);
    expect(r.html).toContain("UNO");
    expect(r.html).toContain("TRES");
    expect(r.html).toContain(">Dos<");
  });
});
