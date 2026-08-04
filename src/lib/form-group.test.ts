// La lista repetible: N elementos con los mismos subcampos.
//
// Lo que se prueba aquí no es "que funcione", sino las cuatro cosas que fallan en SILENCIO:
// la serialización dentro de un string (si cambia, se rompen las filas ya guardadas), el
// scope local de `showIf` (mirar la raíz haría que el elemento 3 se validara con la
// respuesta del 1), el ancho de la hoja (que sale del schema y no de los datos), y las
// claves clonadas del DOM.
import { describe, expect, it } from "vitest";
import { validateSchema, validateSubmission, type FormField } from "./form-fields";
import { renderFormHtml } from "../server/forms/render.server";
import { hojaCsv } from "../server/forms/deliver.server";

const HEREDEROS: FormField = {
  name: "herederos",
  type: "group",
  label: "Herederos",
  required: true,
  itemLabel: "Heredero",
  max: 4,
  fields: [
    { name: "nombre", type: "text", label: "Nombre", required: true },
    { name: "parentesco", type: "select", label: "Parentesco", options: ["hijo", "cónyuge", "otro"] },
    { name: "cual", type: "text", label: "¿Cuál?", showIf: { field: "parentesco", equals: "otro" } },
  ],
};
const FIELDS: FormField[] = [{ name: "titular", type: "text", label: "Titular", required: true }, HEREDEROS];

const items = (v: unknown) => JSON.stringify(v);

describe("lista repetible — validación", () => {
  it("se guarda como JSON dentro de un string, igual que matrix", () => {
    const r = validateSubmission(FIELDS, {
      titular: "Ana",
      herederos: items([{ nombre: "Luis", parentesco: "hijo" }]),
    });
    expect(r.ok).toBe(true);
    // El tipo de `cleanData` sigue siendo Record<string,string>: eso es lo que permite no
    // migrar `data_json` ni tocar hojaCsv, valorPlano ni listSubmissions.
    expect(typeof r.cleanData.herederos).toBe("string");
    // `cual` NO aparece: su showIf no se cumplió, y un campo que el flujo no preguntó no
    // tiene respuesta que registrar. Es la misma regla que en la raíz.
    expect(JSON.parse(r.cleanData.herederos)).toEqual([{ nombre: "Luis", parentesco: "hijo" }]);
  });

  it("exige el mínimo y respeta el máximo", () => {
    expect(validateSubmission(FIELDS, { titular: "Ana", herederos: "[]" }).errors.herederos).toContain("al menos");
    const cinco = items(Array.from({ length: 5 }, (_, i) => ({ nombre: `H${i}` })));
    expect(validateSubmission(FIELDS, { titular: "Ana", herederos: cinco }).errors.herederos).toContain("máximo");
  });

  it("el error apunta al elemento exacto", () => {
    const r = validateSubmission(FIELDS, {
      titular: "Ana",
      herederos: items([{ nombre: "Luis" }, { parentesco: "hijo" }]),
    });
    expect(r.errors["herederos.1.nombre"]).toBe("Nombre es requerido");
    expect(r.errors["herederos.0.nombre"]).toBeUndefined();
  });

  it("showIf es LOCAL al elemento", () => {
    // El elemento 0 dice "otro" (su "¿Cuál?" cuenta); el 1 dice "hijo" (no debe contar, y
    // no debe guardarse). Con un scope compartido, el 1 heredaría la respuesta del 0.
    const r = validateSubmission(FIELDS, {
      titular: "Ana",
      herederos: items([
        { nombre: "Luis", parentesco: "otro", cual: "sobrino" },
        { nombre: "Eva", parentesco: "hijo", cual: "se coló" },
      ]),
    });
    const out = JSON.parse(r.cleanData.herederos);
    expect(out[0].cual).toBe("sobrino");
    expect(out[1]).not.toHaveProperty("cual");
  });

  it("descarta los elementos enteramente vacíos antes de numerar", () => {
    const r = validateSubmission(FIELDS, {
      titular: "Ana",
      herederos: items([{ nombre: "" }, { nombre: "Eva" }]),
    });
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.cleanData.herederos)).toHaveLength(1);
  });

  it("un valor corrupto no tumba el submit", () => {
    const r = validateSubmission(FIELDS, { titular: "Ana", herederos: "{no json" });
    expect(r.errors.herederos).toBeTruthy();
    expect(r.cleanData.herederos).toBe("[]");
  });
});

describe("lista repetible — schema que dicta el modelo", () => {
  const ok = (fields: unknown) => validateSchema(fields);

  it("rechaza lo que el markup no puede sostener", () => {
    const con = (sub: Partial<FormField>) =>
      ok([{ ...HEREDEROS, fields: [{ name: "x", type: "text", label: "X" }, sub] }]);
    // Anidar listas, un archivo por elemento (el upload autoriza por nombre PLANO) y una
    // matrix (sus radios se agrupan por `name` y habría que reescribirlos al reordenar).
    expect(con({ name: "otra", type: "group", label: "Otra", fields: [] })).toMatchObject({ ok: false });
    expect(con({ name: "acta", type: "file", label: "Acta" })).toMatchObject({ ok: false });
    expect(con({ name: "m", type: "matrix", label: "M", options: ["a"], rows: ["b"] })).toMatchObject({ ok: false });
    expect(con({ name: "y", type: "text", label: "Y", section: "Paso" })).toMatchObject({ ok: false });
  });

  it("un subcampo no puede llamarse igual que un campo de la raíz", () => {
    const r = ok([
      { name: "nombre", type: "text", label: "Nombre" },
      { ...HEREDEROS, fields: [{ name: "nombre", type: "text", label: "Nombre" }] },
    ]);
    expect(r).toMatchObject({ ok: false });
  });

  it("un showIf interno sólo apunta a un hermano ANTERIOR", () => {
    const r = ok([
      { name: "titular", type: "text", label: "Titular" },
      {
        ...HEREDEROS,
        // Depende de un campo de la RAÍZ: no tiene semántica por elemento.
        fields: [{ name: "cual", type: "text", label: "Cuál", showIf: { field: "titular", equals: "x" } }],
      },
    ]);
    expect(r).toMatchObject({ ok: false });
  });

  it("el tope de 60 campos cuenta los subcampos", () => {
    const grupo = (i: number) => ({
      name: `g${i}`,
      type: "group",
      label: `G${i}`,
      fields: Array.from({ length: 12 }, (_, j) => ({ name: `g${i}s${j}`, type: "text", label: "x" })),
    });
    // Cada grupo cuenta como 1 + sus 12 subcampos = 13. Cuatro caben (52), cinco no (65).
    expect(ok(Array.from({ length: 4 }, (_, i) => grupo(i)))).toMatchObject({ ok: true });
    expect(ok(Array.from({ length: 5 }, (_, i) => grupo(i)))).toMatchObject({ ok: false });
  });
});

describe("lista repetible — la hoja", () => {
  const fila = (data: Record<string, string>) => ({ at: 1_754_300_000, data, files: {} });

  it("una lista corta se abre en columnas, con el ancho que dice el SCHEMA", () => {
    // 4 × 3 = 12 ≤ 15 → columnas. El ancho NO depende de cuántos herederos llegaron: si
    // dependiera, la hoja cambiaría de forma al llegar una respuesta más larga y rompería
    // los filtros de quien ya la está usando.
    const csv = hojaCsv({ fields: FIELDS }, [fila({ titular: "Ana", herederos: items([{ nombre: "Luis" }]) })]);
    const cab = csv.split("\n")[0];
    expect(cab).toContain("Herederos 1 · Nombre");
    expect(cab).toContain("Herederos 4 · ¿Cuál?");
    expect(csv.split("\n")[1]).toContain("Luis");
  });

  it("una lista larga se aplana a una sola celda", () => {
    const grande: FormField = { ...HEREDEROS, max: 20 };
    const csv = hojaCsv({ fields: [grande] }, [
      fila({ herederos: items([{ nombre: "Luis" }, { nombre: "Eva" }]) }),
    ]);
    expect(csv.split("\n")[0]).toBe("Fecha,Herederos");
    expect(csv).toContain("1) Nombre: Luis");
  });

  it("el ancho no cambia con los datos", () => {
    const uno = hojaCsv({ fields: FIELDS }, [fila({ herederos: items([{ nombre: "A" }]) })]);
    const tres = hojaCsv({ fields: FIELDS }, [
      fila({ herederos: items([{ nombre: "A" }, { nombre: "B" }, { nombre: "C" }]) }),
    ]);
    expect(uno.split("\n")[0]).toBe(tres.split("\n")[0]);
  });
});

describe("lista repetible — el HTML", () => {
  const html = renderFormHtml({
    title: "Intake",
    fields: FIELDS,
    submitUrl: "https://x.test/s",
    uploadUrl: "https://x.test/u",
  });

  it("los bloques viven en una plantilla inerte, no en el documento", () => {
    // Si el `<template>` no fuera inerte, sus data-field con __i__ los leería readAll().
    expect(html).toContain('<template data-tpl="herederos">');
    const fuera = html.slice(0, html.indexOf("<template"));
    expect(fuera).not.toContain("__i__");
  });

  it("no queda ni un data-field duplicado en el documento", () => {
    const cuerpo = html.replace(/<template[\s\S]*?<\/template>/g, "");
    const keys = [...cuerpo.matchAll(/data-field="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("el radio de un subcampo agrupa por su CLAVE, no por el nombre pelado", () => {
    // Dos bloques con el mismo `name` de radio se comportarían como un solo grupo: elegir
    // en el heredero 2 desmarcaría al heredero 1.
    const conRadio = renderFormHtml({
      title: "x",
      fields: [{ ...HEREDEROS, fields: [{ name: "sexo", type: "radio", label: "Sexo", options: ["F", "M"] }] }],
      submitUrl: "https://x.test/s",
      uploadUrl: "https://x.test/u",
    });
    expect(conRadio).toContain('name="herederos.__i__.sexo"');
  });
});
