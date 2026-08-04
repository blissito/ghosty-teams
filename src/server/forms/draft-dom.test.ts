// Repoblar un borrador, EJECUTADO en jsdom.
//
// Es la única forma honesta de probarlo: `writeOne` es ES5 dentro de un template literal, y
// su modo de falla es silencioso — un radio que no se vuelve a marcar, o una lista que
// reaparece con un elemento de más. En pantalla parece que "casi" funcionó.
//
// jsdom a mano y no el entorno `jsdom` de vitest: con ése el archivo se trata como cliente y
// TanStack mockea todo `.server.ts`, así que `renderFormHtml` ni siquiera se importaría.
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { renderFormHtml } from "./render.server";
import type { FormField } from "../../lib/form-fields";

const FIELDS: FormField[] = [
  { name: "nombre", type: "text", label: "Nombre", section: "Uno" },
  { name: "sexo", type: "radio", label: "Sexo", options: ["F", "M"], section: "Uno" },
  { name: "acepto", type: "checkbox", label: "Acepto", section: "Uno" },
  { name: "habitos", type: "matrix", label: "Hábitos", options: ["nunca", "diario"], rows: ["Tabaco"], section: "Dos" },
  { name: "acta", type: "file", label: "Acta", section: "Dos" },
  {
    name: "herederos",
    type: "group",
    label: "Herederos",
    itemLabel: "Heredero",
    max: 4,
    section: "Dos",
    fields: [
      { name: "h_nombre", type: "text", label: "Nombre" },
      { name: "h_edad", type: "number", label: "Edad" },
    ],
  },
];

// El script llama a fetch al arrancar (carga del borrador). Se le da uno que responde lo que
// pida el test, y se espera un tick a que resuelva.
function montar(respuesta: unknown, opts: { hash?: string; drafts?: boolean } = {}) {
  const drafts = opts.drafts !== false;
  const html = renderFormHtml({
    title: "Intake",
    fields: FIELDS,
    submitUrl: "https://x.test/s",
    uploadUrl: "https://x.test/u",
    draftUrl: drafts ? "https://x.test/d" : null,
    publicUrl: "https://x.test/artefacto/abc",
    draftTtlDays: drafts ? 7 : 0,
  });
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "https://x.test/f" + (opts.hash ?? ""),
    beforeParse(w: unknown) {
      const llamadas: unknown[] = [];
      (w as unknown as { __calls: unknown[] }).__calls = llamadas;
      (w as unknown as { fetch: unknown }).fetch = (_u: string, init: { body: string }) => {
        llamadas.push(JSON.parse(init.body));
        return Promise.resolve({ json: () => Promise.resolve(respuesta) });
      };
    },
  });
  // El tipo de `window` que ve TS aquí es el mínimo del proyecto, no el de jsdom.
  const document = (dom.window as unknown as Window & typeof globalThis).document;
  const calls = () => (dom.window as unknown as { __calls: Record<string, unknown>[] }).__calls;
  return { document, calls, window: dom.window };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

const val = (d: Document, k: string) => (d.querySelector(`[data-field="${k}"]`) as HTMLInputElement)?.value;
const marcado = (d: Document, k: string, v: string) =>
  [...d.querySelectorAll(`[data-field="${k}"] input`)].some(
    (n) => (n as HTMLInputElement).value === v && (n as HTMLInputElement).checked
  );

const DATOS = {
  nombre: "Ana",
  sexo: "M",
  acepto: "true",
  habitos: JSON.stringify({ Tabaco: "diario" }),
  acta: "file_abc",
  herederos: JSON.stringify([
    { h_nombre: "Luis", h_edad: "12" },
    { h_nombre: "Eva", h_edad: "40" },
  ]),
};

describe("guardar y continuar — repoblado", () => {
  it("devuelve cada tipo de control a su valor", async () => {
    const { document } = montar({ ok: true, data: DATOS, step: 0 }, { hash: "#d=tok" });
    await tick();
    expect(val(document, "nombre")).toBe("Ana");
    expect(marcado(document, "sexo", "M")).toBe(true);
    expect((document.querySelector('[data-field="acepto"]') as HTMLInputElement).checked).toBe(true);
    // La matrix agrupa sus radios por fila, no por campo.
    const fila = document.querySelector('[data-field="habitos"] tbody tr')!;
    expect([...fila.querySelectorAll("input")].find((i) => i.checked)?.value).toBe("diario");
  });

  it("la lista repetible vuelve con SUS elementos, ni uno más", async () => {
    // El formulario siembra un bloque al cargar; el borrador trae dos. Sin ajustar la
    // cuenta quedarían tres, y el tercero saldría vacío en la hoja del cliente.
    const { document } = montar({ ok: true, data: DATOS, step: 0 }, { hash: "#d=tok" });
    await tick();
    expect(document.querySelectorAll(".gf-item")).toHaveLength(2);
    expect(val(document, "herederos.0.h_nombre")).toBe("Luis");
    expect(val(document, "herederos.1.h_edad")).toBe("40");
  });

  it("el archivo NO se vuelve a subir: se repone su id y su nota", async () => {
    const { document, calls } = montar({ ok: true, data: DATOS, step: 0 }, { hash: "#d=tok" });
    await tick();
    // Un <input type=file> no se puede rellenar por script; lo que importa es que el id
    // viaje en el siguiente envío y que la persona vea que su archivo sigue ahí.
    expect(document.querySelector('[data-filenote="acta"]')?.textContent).toBeTruthy();
    expect((document.querySelector('[data-field="acta"]') as HTMLInputElement).value).toBe("");
    void calls;
  });

  it("vuelve al paso donde se quedó", async () => {
    const { document } = montar({ ok: true, data: DATOS, step: 1 }, { hash: "#d=tok" });
    await tick();
    expect((document.querySelector('[data-step="1"]') as HTMLElement).hidden).toBe(false);
    expect((document.querySelector('[data-step="0"]') as HTMLElement).hidden).toBe(true);
  });

  it("un borrador vencido deja el formulario en blanco y sin ruido", async () => {
    // El servidor responde 404 a lo vencido, borrado o de otro formulario. Decirle "tu
    // borrador caducó" no le devuelve nada a quien tiene que llenarlo igual.
    const { document } = montar({ ok: false }, { hash: "#d=tok" });
    await tick();
    expect(val(document, "nombre")).toBe("");
    expect(document.getElementById("gf-draft")?.hidden).toBe(true);
  });

  it("sin token en el fragmento no pide nada", async () => {
    const { calls } = montar({ ok: true, data: DATOS, step: 0 });
    await tick();
    expect(calls()).toHaveLength(0);
  });

  it("apagado, el formulario no trae ni el recuadro ni una petición", async () => {
    const { document, calls } = montar({ ok: true }, { hash: "#d=tok", drafts: false });
    await tick();
    expect(document.getElementById("gf-draft")).toBeNull();
    expect(calls()).toHaveLength(0);
  });

  it("el enlace que se copia es el PÚBLICO, no el del iframe", async () => {
    // Dentro del iframe `location` es la del artefacto crudo; el enlace que sirve es el de
    // la página que la persona tiene abierta, y por eso viaja horneado.
    const { document } = montar({ ok: true, data: DATOS, step: 0 }, { hash: "#d=tok" });
    await tick();
    expect((document.getElementById("gf-draft-url") as HTMLInputElement).value).toBe(
      "https://x.test/artefacto/abc#d=tok"
    );
    expect(document.getElementById("gf-draft")?.hidden).toBe(false);
  });
});
