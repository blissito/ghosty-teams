// El idioma de un formulario público. Lo que se prueba aquí no es "que traduzca", sino las
// dos cosas que se pueden romper sin que nadie lo note:
//
//   · que no se filtre español al HTML en inglés (un literal olvidado no da error, sale);
//   · que el Sí/No horneado y el Sí/No que VALIDA sean el mismo (viven en archivos distintos:
//     render.server.ts los pinta y form-fields.ts los compara).
import { describe, expect, it } from "vitest";
import { validateSubmission, type FormField } from "../../lib/form-fields";
import { renderFormHtml } from "./render.server";

const FIELDS: FormField[] = [
  { name: "full_name", type: "text", label: "Full name", required: true, section: "About you" },
  { name: "email", type: "email", label: "Email", required: true, section: "About you" },
  { name: "married", type: "radio", label: "Are you married?", required: true, section: "Family" },
  { name: "state", type: "select", label: "State", options: ["Florida", "New York"], section: "Family" },
];

const render = (locale: "es" | "en") =>
  renderFormHtml({
    title: "Estate Planning Intake",
    fields: FIELDS,
    submitUrl: "https://x.test/api/form/tok",
    uploadUrl: "https://x.test/api/form-upload/tok",
    locale,
  });

describe("idioma del formulario público", () => {
  it("hornea el idioma en el <html> y en los botones", () => {
    expect(render("en")).toContain('<html lang="en"');
    expect(render("en")).toContain(">Next<");
    expect(render("en")).toContain(">Submit<");
    expect(render("es")).toContain('<html lang="es"');
    expect(render("es")).toContain(">Siguiente<");
  });

  it("sin locale sigue saliendo en español: los formularios que ya existen no cambian", () => {
    const html = renderFormHtml({
      title: "Alta",
      fields: FIELDS,
      submitUrl: "https://x.test/s",
      uploadUrl: "https://x.test/u",
    });
    expect(html).toContain('<html lang="es"');
    expect(html).toContain(">Enviar<");
  });

  it("no deja ni una palabra en español en el formulario en inglés", () => {
    const html = render("en");
    // Incluye los textos del <script> inline, que es donde es fácil olvidar uno.
    for (const leak of [
      "Siguiente",
      "Enviando",
      "Selecciona",
      "es requerido",
      "no se pudo subir",
      "Sin conexión",
      "Inténtalo",
      "Gracias",
      "No llenar",
    ]) {
      expect(html, `se filtró "${leak}"`).not.toContain(leak);
    }
  });

  it("el Sí/No que se pinta es el mismo que valida", () => {
    // Un radio sin `options` usa el default del diccionario. Si el HTML dijera "Yes" y el
    // validador comparara contra "Sí", cada respuesta a esa pregunta sería inválida.
    expect(render("en")).toContain(">Yes<");
    expect(validateSubmission(FIELDS, { married: "Yes" }, "en").errors.married).toBeUndefined();
    expect(validateSubmission(FIELDS, { married: "Yes" }, "es").errors.married).toBe("Opción inválida");
    expect(validateSubmission(FIELDS, { married: "Sí" }, "es").errors.married).toBeUndefined();
  });

  it("los errores de validación salen en el idioma del formulario", () => {
    const en = validateSubmission(FIELDS, { email: "nope" }, "en").errors;
    expect(en.full_name).toBe("Full name is required");
    expect(en.email).toBe("Invalid email");

    const es = validateSubmission(FIELDS, { email: "nope" }, "es").errors;
    expect(es.full_name).toBe("Full name es requerido");
    expect(es.email).toBe("Correo inválido");
  });
});
