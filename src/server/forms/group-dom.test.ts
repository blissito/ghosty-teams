// El script del formulario, EJECUTADO. No hay otra forma honesta de probar el clonado: es
// ES5 escrito dentro de un template literal, así que ni el typecheck ni un test de string
// ven si `reindex()` dejó dos bloques con el mismo `data-field` — el modo de falla es que
// el heredero 2 escriba encima del heredero 1, y en pantalla se ve bien hasta que alguien
// revisa las respuestas.
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { renderFormHtml } from "./render.server";
import type { FormField } from "../../lib/form-fields";

const FIELDS: FormField[] = [
  { name: "titular", type: "text", label: "Titular", required: true },
  {
    name: "herederos",
    type: "group",
    label: "Herederos",
    itemLabel: "Heredero",
    max: 3,
    fields: [
      { name: "nombre", type: "text", label: "Nombre", required: true },
      { name: "parentesco", type: "select", label: "Parentesco", options: ["hijo", "otro"] },
      { name: "cual", type: "text", label: "¿Cuál?", showIf: { field: "parentesco", equals: "otro" } },
    ],
  },
];

// jsdom a mano y NO el entorno `jsdom` de vitest: con ese entorno el archivo se trata como
// cliente y TanStack mockea todo `.server.ts`, así que `renderFormHtml` ni siquiera se
// importa. De paso, `runScripts: "dangerously"` ejecuta el <script> igual que un navegador
// al parsear, en vez de evaluarlo a mano.
let document: Document;
function montar(fields = FIELDS) {
  const html = renderFormHtml({
    title: "Intake",
    fields,
    submitUrl: "https://x.test/s",
    uploadUrl: "https://x.test/u",
  });
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://x.test/f" });
  // El tipo de `window` que ve TS aquí es el mínimo del proyecto, no el de jsdom.
  document = (dom.window as unknown as Window & typeof globalThis).document;
  return document;
}

const campos = () =>
  [...document.querySelectorAll('.gf-items [data-field]')].map((n) => n.getAttribute("data-field"));
const agregar = () => (document.querySelector('[data-add="herederos"]') as HTMLElement).click();
const quitar = (i: number) =>
  (document.querySelectorAll('[data-rm="herederos"]')[i] as HTMLElement).click();
const escribir = (key: string, v: string) => {
  const n = document.querySelector(`[data-field="${key}"]`) as HTMLInputElement;
  n.value = v;
  const w = n.ownerDocument.defaultView!;
  n.dispatchEvent(new w.Event("input", { bubbles: true }));
  n.dispatchEvent(new w.Event("change", { bubbles: true }));
};

describe("lista repetible en el navegador", () => {
  it("siembra un bloque al cargar y no deja rastro de la plantilla", () => {
    montar();
    expect(document.querySelectorAll(".gf-item")).toHaveLength(1);
    expect(campos()).toEqual([
      "herederos.0.nombre",
      "herederos.0.parentesco",
      "herederos.0.cual",
    ]);
    // Ni un `__i__` en un ATRIBUTO vivo: si quedara, `readAll()` leería un campo fantasma.
    // Se miran los atributos y no el innerHTML porque el propio script menciona el literal.
    const sucios = [...document.querySelectorAll("*")]
      .filter((n) => !n.closest("template"))
      .flatMap((n) => [...n.attributes].map((a) => `${a.name}=${a.value}`))
      .filter((v) => v.includes("__i__"));
    expect(sucios).toEqual([]);
  });

  it("cada bloque nuevo tiene claves propias, sin duplicados", () => {
    montar();
    agregar();
    agregar();
    const k = campos();
    expect(new Set(k).size).toBe(k.length);
    expect(k).toContain("herederos.2.nombre");
  });

  it("quitar uno de EN MEDIO renumera a los de abajo", () => {
    // Éste es el caso que rompe un clonado ingenuo: sin renumerar, el tercer bloque se
    // queda con el índice 2 y el segundo hueco nunca se llena.
    montar();
    agregar();
    agregar();
    escribir("herederos.2.nombre", "tercero");
    quitar(1);
    expect(campos()).toEqual([
      "herederos.0.nombre", "herederos.0.parentesco", "herederos.0.cual",
      "herederos.1.nombre", "herederos.1.parentesco", "herederos.1.cual",
    ]);
    // Y el valor viaja con su bloque, no con su índice.
    expect((document.querySelector('[data-field="herederos.1.nombre"]') as HTMLInputElement).value).toBe("tercero");
  });

  it("el showIf de un bloque no contagia a los demás", () => {
    montar();
    agregar();
    escribir("herederos.0.parentesco", "otro");
    const oculto = (key: string) =>
      (document.querySelector(`.gf-field[data-for="${key}"]`) as HTMLElement).hidden;
    expect(oculto("herederos.0.cual")).toBe(false);
    expect(oculto("herederos.1.cual")).toBe(true);
  });

  it("el botón de agregar desaparece en el máximo", () => {
    montar();
    agregar();
    agregar();
    expect(document.querySelectorAll(".gf-item")).toHaveLength(3);
    expect((document.querySelector('[data-add="herederos"]') as HTMLElement).hidden).toBe(true);
    agregar(); // clic de más: no debe pasar nada
    expect(document.querySelectorAll(".gf-item")).toHaveLength(3);
  });

  it("el encabezado se renumera con los bloques", () => {
    montar();
    agregar();
    quitar(0);
    expect(document.querySelector(".gf-item-n")?.textContent).toBe("Heredero 1");
  });
});
