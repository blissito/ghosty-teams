import { describe, expect, it } from "vitest";
import { formSteps, isFieldVisible, validateSchema, validateSubmission, type FormField } from "./form-fields";

const FIELDS: FormField[] = [
  { name: "razon_social", type: "text", label: "Razón social", required: true, section: "Datos" },
  { name: "tipo", type: "radio", label: "Tipo", options: ["Física", "Moral"], required: true, section: "Datos" },
  { name: "rfc", type: "text", label: "RFC", required: true, showIf: { field: "tipo", equals: "Moral" }, section: "Datos" },
  { name: "email", type: "email", label: "Correo", required: true, section: "Contacto" },
  { name: "riesgos", type: "matrix", label: "Riesgos", options: ["Sí", "No"], rows: ["Litigio", "Auditoría"], required: true, section: "Dx" },
  { name: "acepta", type: "checkbox", label: "Acepto", required: true, section: "Dx" },
];

describe("visibilidad", () => {
  it("un campo condicionado se oculta hasta que la dependencia coincide EXACTO", () => {
    const rfc = FIELDS[2];
    expect(isFieldVisible(rfc, {})).toBe(false);
    expect(isFieldVisible(rfc, { tipo: "Física" })).toBe(false);
    expect(isFieldVisible(rfc, { tipo: "moral" })).toBe(false);
    expect(isFieldVisible(rfc, { tipo: "Moral" })).toBe(true);
  });

  it("un campo OCULTO no se valida y NO llega a los datos guardados", () => {
    const r = validateSubmission(FIELDS, {
      razon_social: "Acme",
      tipo: "Física",
      email: "a@b.com",
      riesgos: JSON.stringify({ Litigio: "No", Auditoría: "Sí" }),
      acepta: "true",
    });
    expect(r.ok).toBe(true);
    // Es `required`, y aun así no bloquea: el flujo nunca lo preguntó.
    expect("rfc" in r.cleanData).toBe(false);
  });
});

describe("validación", () => {
  it("junta un error por campo con el mensaje de su etiqueta", () => {
    const r = validateSubmission(FIELDS, { razon_social: "Acme", tipo: "Moral", email: "malo", riesgos: "{}", acepta: "true" });
    expect(r.ok).toBe(false);
    expect(r.errors.rfc).toBe("RFC es requerido");
    expect(r.errors.email).toBe("Correo inválido");
    expect(r.errors.riesgos).toContain("responde todas las filas");
  });

  it("una opción que no está en la lista es inválida (no se guarda texto libre)", () => {
    const r = validateSubmission(FIELDS, { razon_social: "A", tipo: "Otra", email: "a@b.com", riesgos: "{}", acepta: "true" });
    expect(r.errors.tipo).toBe("Opción inválida");
  });

  it("una matriz con una columna inventada es inválida", () => {
    const r = validateSubmission(FIELDS, {
      razon_social: "A", tipo: "Física", email: "a@b.com", acepta: "true",
      riesgos: JSON.stringify({ Litigio: "Quizá", Auditoría: "No" }),
    });
    expect(r.errors.riesgos).toBe("Opción inválida");
  });
});

describe("schema del agente", () => {
  it("acepta un schema bien formado y lo normaliza", () => {
    const v = validateSchema(FIELDS);
    expect(v.ok).toBe(true);
  });

  it("rechaza nombres que no son seguros como clave/selector", () => {
    for (const name of ["Razón Social", "a-b", "__proto__", "1x", ""]) {
      const v = validateSchema([{ name, type: "text", label: "X" }]);
      expect(v.ok, name).toBe(false);
    }
  });

  it("rechaza un showIf que apunta hacia adelante (quedaría oculto para siempre)", () => {
    const v = validateSchema([
      { name: "rfc", type: "text", label: "RFC", showIf: { field: "tipo", equals: "Moral" } },
      { name: "tipo", type: "radio", label: "Tipo", options: ["Física", "Moral"] },
    ]);
    expect(v.ok).toBe(false);
  });

  it("exige options y rows en una matriz", () => {
    expect(validateSchema([{ name: "m", type: "matrix", label: "M", options: ["a"] }]).ok).toBe(false);
    expect(validateSchema([{ name: "m", type: "matrix", label: "M", rows: ["r"] }]).ok).toBe(false);
  });
});

describe("pasos", () => {
  it("agrupa por sección consecutiva", () => {
    expect(formSteps(FIELDS).map((s) => s.title)).toEqual(["Datos", "Contacto", "Dx"]);
  });
  it("sin secciones, parte en trozos fijos", () => {
    const flat: FormField[] = Array.from({ length: 12 }, (_, i) => ({ name: `c${i}`, type: "text", label: `C${i}` }));
    expect(formSteps(flat).length).toBe(3);
  });
});

describe("hoja de respuestas (una fila por respuesta)", () => {
  it("encabeza con las ETIQUETAS y aplana la matriz en una celda", async () => {
    const { hojaCsv } = await import("../server/forms/deliver.server");
    const csv = hojaCsv({ fields: FIELDS }, [
      {
        at: 1785000000,
        data: {
          razon_social: "Acme, SA de CV",
          tipo: "Moral",
          rfc: "ACM123",
          email: "a@b.com",
          riesgos: JSON.stringify({ Litigio: "Sí", Auditoría: "No" }),
          acepta: "true",
        },
        files: {},
      },
    ]);
    const [cab, fila] = csv.split("\n");
    expect(cab).toContain("Razón social");
    expect(cab).not.toContain("razon_social"); // la clave interna no sale nunca
    expect(fila).toContain('"Acme, SA de CV"'); // la coma obliga comillas
    expect(fila).toContain("Litigio: Sí; Auditoría: No");
    expect(fila.endsWith("Sí")).toBe(true); // checkbox
  });

  it("un campo que el flujo no preguntó queda VACÍO, no con guión", async () => {
    const { hojaCsv } = await import("../server/forms/deliver.server");
    const csv = hojaCsv({ fields: FIELDS }, [
      { at: 1785000000, data: { razon_social: "X", tipo: "Física", email: "a@b.com", acepta: "true" }, files: {} },
    ]);
    // 7 columnas (Fecha + 6 campos) → 6 comas mínimo, y sin "—" en ninguna celda
    expect(csv).not.toContain("—");
    expect(csv.split("\n")[1].split(",").length).toBeGreaterThanOrEqual(7);
  });

  it("dos respuestas = dos filas, en orden", async () => {
    const { hojaCsv } = await import("../server/forms/deliver.server");
    const una = { at: 1785000000, data: { razon_social: "Uno", tipo: "Física", email: "a@b.com", acepta: "true" }, files: {} };
    const dos = { at: 1785000600, data: { razon_social: "Dos", tipo: "Física", email: "c@d.com", acepta: "true" }, files: {} };
    const csv = hojaCsv({ fields: FIELDS }, [una, dos]);
    const lineas = csv.split("\n");
    expect(lineas.length).toBe(3);
    expect(lineas[1]).toContain("Uno");
    expect(lineas[2]).toContain("Dos");
  });
});
