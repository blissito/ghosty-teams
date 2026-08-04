// La ficha de una respuesta.
//
// Aquí se prueba el MARKDOWN, que es la parte con reglas y sin red. La idempotencia de
// `ensureFicha` vive contra la DB (compare-and-swap sobre `ficha_document_id`) y no se puede
// probar sin sqld; lo que sí se puede fijar por test es lo que un expediente no perdona:
// que ausente y vacío se impriman DISTINTO, y que un pipe de quien responde no rompa la
// tabla de una matrix.
import { describe, expect, it } from "vitest";
import { fichaMarkdown } from "./ficha.server";
import type { FormField } from "../../lib/form-fields";

const AT = 1_754_300_000;

const FIELDS: FormField[] = [
  { name: "nombre", type: "text", label: "Nombre", section: "Contacto" },
  { name: "casado", type: "radio", label: "¿Casado?", section: "Contacto" },
  { name: "regimen", type: "text", label: "Régimen", showIf: { field: "casado", equals: "Sí" } },
  {
    name: "herederos",
    type: "group",
    label: "Herederos",
    itemLabel: "Heredero",
    fields: [
      { name: "h_nombre", type: "text", label: "Nombre" },
      { name: "h_parentesco", type: "text", label: "Parentesco" },
    ],
  },
  { name: "habitos", type: "matrix", label: "Hábitos", options: ["nunca", "diario"], rows: ["Tabaco"] },
  { name: "acepto", type: "checkbox", label: "Consentimiento" },
];

const form = { title: "Intake", fields: FIELDS, locale: "es" as const };

describe("fichaMarkdown", () => {
  it("distingue 'no se preguntó' de 'no contestaron'", () => {
    // `regimen` NO está en los datos: su showIf no se cumplió y nunca se mostró, así que no
    // aparece. `nombre` sí está y vino vacío: aparece con guión. En un expediente esa
    // diferencia es la que separa "no aplica" de "falta el dato".
    const md = fichaMarkdown(form, { nombre: "", casado: "No" }, {}, AT);
    expect(md).not.toContain("Régimen");
    expect(md).toContain("**Nombre:** —");
  });

  it("la sección se imprime UNA vez y sólo si hay algo debajo", () => {
    const md = fichaMarkdown(form, { nombre: "Ana", casado: "No" }, {}, AT);
    expect(md.match(/## Contacto/g)).toHaveLength(1);
  });

  it("una lista repetible sale como lista numerada, no como tabla", () => {
    const md = fichaMarkdown(
      form,
      { herederos: JSON.stringify([{ h_nombre: "Luis", h_parentesco: "hijo" }, { h_nombre: "Eva" }]) },
      {},
      AT
    );
    expect(md).toContain("1. **Luis**");
    expect(md).toContain("   - Parentesco: hijo");
    // El segundo no trae parentesco: no se preguntó por él, no se inventa un guión.
    expect(md).toContain("2. **Eva**");
    expect(md.match(/- Parentesco:/g)).toHaveLength(1);
    expect(md).not.toContain("| --- |");
  });

  it("una lista vacía no desaparece: deja constancia de que se preguntó", () => {
    expect(fichaMarkdown(form, { herederos: "[]" }, {}, AT)).toContain("### Herederos");
  });

  it("un valor corrupto no tumba la ficha", () => {
    const md = fichaMarkdown(form, { herederos: "{no json", habitos: "{tampoco" }, {}, AT);
    expect(md).toContain("### Herederos");
    expect(md).toContain("| Tabaco | — |");
  });

  it("escapa lo que escribió quien responde", () => {
    // Un pipe partiría la fila de la matrix en dos columnas; un asterisco pondría en
    // negritas media ficha. El texto lo manda un tercero.
    const md = fichaMarkdown(form, { nombre: "Ana | *Beta*" }, {}, AT);
    expect(md).toContain("Ana \\| \\*Beta\\*");
  });

  it("el archivo sale por su nombre de NUESTRA tabla, no por el valor guardado", () => {
    const md = fichaMarkdown(
      { ...form, fields: [{ name: "acta", type: "file", label: "Acta" }] },
      { acta: "file_abc" },
      { acta: { name: "acta.pdf" } },
      AT
    );
    expect(md).toContain("📎 acta.pdf");
    expect(md).not.toContain("file_abc");
  });

  it("respeta el idioma del formulario", () => {
    const md = fichaMarkdown({ ...form, locale: "en" }, { acepto: "true" }, {}, AT);
    expect(md).toContain("Submitted on");
    expect(md).toContain("**Consentimiento:** Yes");
  });

  it("fecha la respuesta, no el momento de generarla", () => {
    // La ficha se puede pedir meses después: si tomara `new Date()`, diría la fecha en que
    // alguien la mandó imprimir y no la que tiene valor.
    expect(fichaMarkdown(form, { nombre: "Ana" }, {}, AT)).toContain("agosto de 2025");
  });
});
