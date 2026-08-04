// Contrato de los campos de un formulario nativo. ISOMORFO a propósito: este archivo lo
// importa el renderer del servidor, el validador del endpoint de submit Y —serializado
// dentro del <script> del formulario— el navegador de quien responde.
//
// Es UNA sola implementación porque la versión de EasyBits tenía dos (`isFieldVisible`
// duplicada a mano en la ruta pública y en el core), y de ahí salían las divergencias:
// el cliente escondía un campo que el servidor seguía exigiendo, o al revés.
//
// Sin imports salvo su diccionario hermano (`form-strings.ts`), que tampoco tiene ninguno:
// cualquier otra dependencia lo ataría a un entorno y dejaría de poder viajar dentro del
// HTML publicado.
import { fill, formStrings, type FormLocale } from "./form-strings";

export type FormFieldType =
  | "text"
  | "email"
  | "tel"
  | "textarea"
  | "select"
  | "date"
  | "number"
  | "checkbox" // consentimiento: se guarda "true" | ""
  | "radio" // opción única (options, o Sí/No si no hay)
  | "file" // el valor es el fileId que devuelve el upload
  | "matrix"; // rejilla rows × options; el valor es JSON {fila: columna}

export interface FormField {
  name: string;
  type: FormFieldType;
  label: string;
  required?: boolean;
  placeholder?: string;
  /** select/radio: las opciones. matrix: los ENCABEZADOS DE COLUMNA. */
  options?: string[];
  /** matrix: las filas (cada una lleva una respuesta entre `options`). */
  rows?: string[];
  /** file: filtro de tipos, tal cual el atributo accept. */
  accept?: string;
  /** Se muestra sólo si otro campo vale exactamente esto (condición ÚNICA, igualdad de texto). */
  showIf?: { field: string; equals: string };
  /** Campos consecutivos con la misma `section` forman un paso del wizard. */
  section?: string;
}

export const FIELD_TYPES: FormFieldType[] = [
  "text", "email", "tel", "textarea", "select", "date", "number", "checkbox", "radio", "file", "matrix",
];

/** Pasos fijos cuando ningún campo declara `section`. */
export const STEP_SIZE = 5;

/**
 * ¿Se le muestra este campo a quien responde? Igualdad ESTRICTA de texto contra el valor
 * actual del campo del que depende. Un campo oculto no se valida y NO llega a los datos
 * guardados: si el flujo no lo mostró, no hay respuesta que registrar.
 */
export function isFieldVisible(field: FormField, data: Record<string, string>): boolean {
  if (!field.showIf) return true;
  const dep = data[field.showIf.field];
  return typeof dep === "string" && dep === field.showIf.equals;
}

const RE = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  tel: /^[\d\s\-+()]{7,20}$/,
  number: /^-?\d+(\.\d+)?$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
};

export type ValidationResult = {
  ok: boolean;
  errors: Record<string, string>;
  /** Sólo los campos VISIBLES, ya recortados. Es lo que se guarda. */
  cleanData: Record<string, string>;
};

/**
 * Valida la respuesta contra el schema. Mismo resultado en el navegador y en el servidor:
 * el cliente lo usa para no dejar avanzar de paso, el servidor porque el cliente es
 * opcional (nada impide un POST a mano).
 *
 * `locale` es opcional y cae a español: así ningún llamador viejo cambia de comportamiento.
 */
export function validateSubmission(
  fields: FormField[],
  raw: Record<string, unknown>,
  locale?: FormLocale
): ValidationResult {
  const s = formStrings(locale);
  const errors: Record<string, string> = {};
  const cleanData: Record<string, string> = {};
  // Los `showIf` se resuelven contra los valores YA limpios: un campo sólo puede depender
  // de uno anterior (lo garantiza la validación del schema al crear el formulario).
  const seen: Record<string, string> = {};

  for (const field of fields) {
    if (!isFieldVisible(field, seen)) continue;

    const v = raw[field.name];
    const value = typeof v === "string" ? v.trim() : v === true ? "true" : "";
    seen[field.name] = value;

    if (field.required && !value) {
      errors[field.name] = fill(s.required, { label: field.label });
      continue;
    }

    if (value) {
      const bad = validateValue(field, value, locale);
      if (bad) {
        errors[field.name] = bad;
        continue;
      }
    }

    cleanData[field.name] = value;
  }

  return { ok: Object.keys(errors).length === 0, errors, cleanData };
}

function validateValue(field: FormField, value: string, locale?: FormLocale): string | null {
  const s = formStrings(locale);
  switch (field.type) {
    case "email":
      return RE.email.test(value) ? null : s.invalidEmail;
    case "tel":
      return RE.tel.test(value) ? null : s.invalidTel;
    case "number":
      return RE.number.test(value) ? null : s.invalidNumber;
    case "date":
      return RE.date.test(value) ? null : s.invalidDate;
    case "select":
    case "radio": {
      // El default Sí/No de un radio sin opciones se hornea en el HTML con el idioma del
      // formulario: aquí hay que comparar contra ESAS mismas etiquetas o nada valida.
      const opts = field.options?.length ? field.options : [s.yes, s.no];
      return opts.includes(value) ? null : s.invalidOption;
    }
    case "matrix": {
      let sel: Record<string, string>;
      try {
        sel = JSON.parse(value) as Record<string, string>;
      } catch {
        return s.invalidAnswer;
      }
      if (!sel || typeof sel !== "object" || Array.isArray(sel)) return s.invalidAnswer;
      const cols = field.options ?? [];
      if (cols.length && Object.values(sel).some((c) => !cols.includes(c as string))) return s.invalidOption;
      if (field.required && (field.rows ?? []).some((r) => !sel[r]))
        return fill(s.matrixIncomplete, { label: field.label });
      return null;
    }
    default:
      return null;
  }
}

/** Pasos del wizard: agrupa consecutivos por `section`; sin secciones, trozos de STEP_SIZE. */
export function formSteps(fields: FormField[]): { title: string | null; fields: FormField[] }[] {
  if (fields.some((f) => f.section)) {
    const steps: { title: string | null; fields: FormField[] }[] = [];
    for (const f of fields) {
      const title = f.section ?? null;
      const last = steps[steps.length - 1];
      if (last && last.title === title) last.fields.push(f);
      else steps.push({ title, fields: [f] });
    }
    return steps;
  }
  const steps: { title: string | null; fields: FormField[] }[] = [];
  for (let i = 0; i < fields.length; i += STEP_SIZE) {
    steps.push({ title: null, fields: fields.slice(i, i + STEP_SIZE) });
  }
  return steps;
}

/**
 * Escapa para HTML. Incluye `'` — el de EasyBits no lo hacía y el resultado acababa dentro
 * de atributos delimitados por comilla simple, o sea una inyección esperando.
 */
export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Revisa un schema recién dictado por el agente. Devuelve el primer problema en español
 * (va de vuelta al modelo como error de tool) o null.
 *
 * `name` acotado a [a-z0-9_] no es cosmético: viaja a claves de objeto, a selectores
 * `[data-field="…"]` y a nombres de columna de una hoja; un nombre libre sería inyección
 * en los tres sitios.
 */
export function validateSchema(fields: unknown): { ok: true; fields: FormField[] } | { ok: false; error: string } {
  if (!Array.isArray(fields) || fields.length === 0) return { ok: false, error: "manda al menos un campo" };
  if (fields.length > 60) return { ok: false, error: "demasiados campos (máx 60)" };

  const out: FormField[] = [];
  const names = new Set<string>();

  for (const raw of fields) {
    const f = raw as Partial<FormField>;
    const name = String(f?.name ?? "");
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(name)) {
      return { ok: false, error: `nombre de campo inválido: "${name}" (usa minúsculas, números y _)` };
    }
    if (names.has(name)) return { ok: false, error: `el campo "${name}" está repetido` };
    names.add(name);

    const type = String(f?.type ?? "") as FormFieldType;
    if (!FIELD_TYPES.includes(type)) return { ok: false, error: `tipo inválido en "${name}": ${type}` };

    const label = String(f?.label ?? "").trim();
    if (!label) return { ok: false, error: `el campo "${name}" no tiene etiqueta` };

    const options = Array.isArray(f?.options) ? f!.options!.map(String).filter(Boolean) : undefined;
    const rows = Array.isArray(f?.rows) ? f!.rows!.map(String).filter(Boolean) : undefined;

    if (type === "select" && !options?.length) return { ok: false, error: `"${name}" es select y no trae options` };
    if (type === "matrix") {
      if (!options?.length) return { ok: false, error: `"${name}" es matrix y no trae options (las columnas)` };
      if (!rows?.length) return { ok: false, error: `"${name}" es matrix y no trae rows (las filas)` };
      if (rows.length > 40) return { ok: false, error: `"${name}": demasiadas filas (máx 40)` };
    }

    let showIf: FormField["showIf"];
    if (f?.showIf) {
      const dep = String(f.showIf.field ?? "");
      // Sólo hacia atrás: si dependiera de un campo posterior, el paso donde se decide
      // aún no existe y el campo quedaría oculto para siempre.
      if (!names.has(dep) || dep === name) {
        return { ok: false, error: `"${name}" depende de "${dep}", que no está definido antes` };
      }
      showIf = { field: dep, equals: String(f.showIf.equals ?? "") };
    }

    out.push({
      name,
      type,
      label,
      ...(f?.required ? { required: true } : {}),
      ...(f?.placeholder ? { placeholder: String(f.placeholder) } : {}),
      ...(options ? { options } : {}),
      ...(rows ? { rows } : {}),
      ...(f?.accept ? { accept: String(f.accept) } : {}),
      ...(showIf ? { showIf } : {}),
      ...(f?.section ? { section: String(f.section) } : {}),
    });
  }

  return { ok: true, fields: out };
}
