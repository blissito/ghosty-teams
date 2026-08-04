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
  | "matrix" // rejilla rows × options; el valor es JSON {fila: columna}
  | "group"; // lista REPETIBLE: N elementos con los mismos subcampos; el valor es JSON [{sub: valor}]

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
  /** group: los subcampos que se repiten. UN SOLO NIVEL (ver `validateSchema`). */
  fields?: FormField[];
  /** group: cuántos elementos se piden como mínimo (sólo aplica si el grupo es `required`). */
  min?: number;
  /** group: tope de elementos. Fija el ancho de la hoja, así que NO se puede bajar. */
  max?: number;
  /** group: cómo se llama UN elemento ("Heredero", "Dependiente"). Sale en el botón y en cada bloque. */
  itemLabel?: string;
}

export const FIELD_TYPES: FormFieldType[] = [
  "text", "email", "tel", "textarea", "select", "date", "number", "checkbox", "radio", "file", "matrix", "group",
];

/** Tope de elementos de un grupo. Es lo que acota el ancho de la hoja de respuestas. */
export const GROUP_MAX = 20;
/** `max` cuando el schema no lo dice. */
export const GROUP_DEFAULT_MAX = 10;

/**
 * La clave con la que se identifica un subcampo dentro del elemento `i` de un grupo:
 * `herederos.0.nombre`. Se usa igual para los errores, para `data-field` en el DOM y para
 * el salto al paso del primer error.
 *
 * El punto NO puede aparecer en un `name` de raíz (`validateSchema` lo acota a
 * `[a-z][a-z0-9_]*`), así que este espacio de nombres no puede chocar con uno real — que es
 * lo que permite que `el()` y `showError()` del cliente sigan funcionando sin tocarse.
 */
export function itemKey(group: string, index: number, sub: string): string {
  return `${group}.${index}.${sub}`;
}

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

    // Una lista repetible se valida elemento por elemento y sus errores van con clave
    // `grupo.i.subcampo`, para que el cliente pueda señalar el bloque exacto.
    if (field.type === "group") {
      const g = validateGroup(field, raw[field.name], locale);
      Object.assign(errors, g.errors);
      // El valor limpio se guarda AUNQUE haya errores en otros campos: `cleanData` sólo se
      // usa cuando todo salió bien, y así el grupo no necesita un camino aparte.
      cleanData[field.name] = g.value;
      seen[field.name] = g.value;
      continue;
    }

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

/**
 * Valida una lista repetible. Devuelve el valor ya limpio —un JSON de array de objetos, el
 * mismo truco que usa `matrix`— y los errores con clave `grupo.i.subcampo`.
 *
 * Se guarda como STRING a propósito: `cleanData` es `Record<string,string>` y así lo lee
 * todo lo demás (`hojaCsv`, `valorPlano`, `listSubmissions`, las filas ya guardadas).
 * Estructurarlo aquí obligaría a migrar la tabla y a tocar cuatro consumidores para ganar
 * nada: quien quiere la estructura la re-hidrata al LEER, que es barato y reversible.
 */
function validateGroup(
  field: FormField,
  rawValue: unknown,
  locale?: FormLocale
): { value: string; errors: Record<string, string> } {
  const s = formStrings(locale);
  const errors: Record<string, string> = {};
  const subs = field.fields ?? [];
  const max = Math.min(GROUP_MAX, Math.max(1, field.max ?? GROUP_DEFAULT_MAX));

  let items: unknown[];
  try {
    const parsed = typeof rawValue === "string" && rawValue.trim() ? JSON.parse(rawValue) : [];
    items = Array.isArray(parsed) ? parsed : [];
    if (!Array.isArray(parsed) && rawValue) {
      errors[field.name] = s.invalidAnswer;
      return { value: "[]", errors };
    }
  } catch {
    errors[field.name] = s.invalidAnswer;
    return { value: "[]", errors };
  }

  // Un elemento ENTERAMENTE vacío se descarta antes de validar: alguien pulsa "Agregar" y
  // se arrepiente, y no tiene sentido exigirle que lo borre. Se hace primero para que los
  // índices de los errores coincidan con los bloques que quedan en pantalla.
  const usable = items
    .map((it) => (it && typeof it === "object" && !Array.isArray(it) ? (it as Record<string, unknown>) : {}))
    .filter((it) => subs.some((f) => texto(it[f.name])));

  if (usable.length > max) {
    errors[field.name] = fill(s.maxItems, { label: field.label, n: max });
    usable.length = max;
  }

  const min = field.required ? Math.max(1, Math.min(field.min ?? 1, max)) : (field.min ?? 0);
  if (usable.length < min) {
    errors[field.name] = fill(s.minItems, { label: field.label, n: min });
  }

  const limpios: Record<string, string>[] = [];
  usable.forEach((it, i) => {
    // ⚠️ El scope de `showIf` dentro de un elemento es LOCAL: un subcampo sólo puede
    // depender de otro subcampo del MISMO elemento (`validateSchema` lo exige). Mirar el
    // scope de la raíz haría que el elemento 3 se validara con la respuesta del elemento 1.
    const scope: Record<string, string> = {};
    const limpio: Record<string, string> = {};
    for (const sub of subs) {
      if (!isFieldVisible(sub, scope)) continue;
      const value = texto(it[sub.name]);
      scope[sub.name] = value;
      const key = itemKey(field.name, i, sub.name);
      if (sub.required && !value) {
        errors[key] = fill(s.required, { label: sub.label });
        continue;
      }
      if (value) {
        const bad = validateValue(sub, value, locale);
        if (bad) {
          errors[key] = bad;
          continue;
        }
      }
      limpio[sub.name] = value;
    }
    limpios.push(limpio);
  });

  return { value: JSON.stringify(limpios), errors };
}

/** Un valor de subcampo, normalizado igual que en la raíz (checkbox llega como boolean). */
function texto(v: unknown): string {
  return typeof v === "string" ? v.trim() : v === true ? "true" : "";
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

  const out: FormField[] = [];
  const names = new Set<string>();
  // El tope cuenta también los subcampos de los grupos: 5 grupos de 12 son 60 preguntas
  // igual que 60 campos sueltos, y quien las contesta no nota la diferencia.
  let total = 0;

  for (const raw of fields) {
    const r = parseField(raw, names, null);
    if (!r.ok) return r;
    total += 1 + (r.field.fields?.length ?? 0);
    if (total > 60) return { ok: false, error: "demasiados campos (máx 60, contando los de cada lista)" };
    out.push(r.field);
  }

  return { ok: true, fields: out };
}

/**
 * Un campo del schema. `parent` es null en la raíz y el nombre del grupo dentro de una
 * lista repetible — con eso se aplican las reglas que sólo valen adentro.
 */
function parseField(
  raw: unknown,
  names: Set<string>,
  parent: string | null
): { ok: true; field: FormField } | { ok: false; error: string } {
  const f = raw as Partial<FormField>;
  const name = String(f?.name ?? "");
  const dónde = parent ? `"${parent}" → "${name}"` : `"${name}"`;
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(name)) {
    return { ok: false, error: `nombre de campo inválido: "${name}" (usa minúsculas, números y _)` };
  }
  // Los nombres de subcampo comparten espacio con los de la raíz aunque vivan anidados:
  // `data-field` y las claves de error usan `grupo.i.subcampo`, y un subcampo llamado igual
  // que un campo suelto haría ambiguo cualquier mensaje de error.
  if (names.has(name)) return { ok: false, error: `el campo "${name}" está repetido` };
  names.add(name);

  const type = String(f?.type ?? "") as FormFieldType;
  if (!FIELD_TYPES.includes(type)) return { ok: false, error: `tipo inválido en ${dónde}: ${type}` };

  const label = String(f?.label ?? "").trim();
  if (!label) return { ok: false, error: `el campo ${dónde} no tiene etiqueta` };

  const options = Array.isArray(f?.options) ? f!.options!.map(String).filter(Boolean) : undefined;
  const rows = Array.isArray(f?.rows) ? f!.rows!.map(String).filter(Boolean) : undefined;

  if (type === "select" && !options?.length) return { ok: false, error: `${dónde} es select y no trae options` };
  if (type === "matrix") {
    if (!options?.length) return { ok: false, error: `${dónde} es matrix y no trae options (las columnas)` };
    if (!rows?.length) return { ok: false, error: `${dónde} es matrix y no trae rows (las filas)` };
    if (rows.length > 40) return { ok: false, error: `${dónde}: demasiadas filas (máx 40)` };
  }

  if (parent) {
    // Dentro de una lista repetible no cabe todo:
    if (type === "group") return { ok: false, error: `${dónde}: una lista no puede contener otra lista` };
    // El upload autoriza por nombre PLANO (`api.form-upload.$token.ts`), así que un archivo
    // por elemento necesitaría claves con ruta en `gt_form_files`. Mientras no exista eso,
    // se rechaza aquí y no en el submit: el modelo se entera al crear, no el usuario al
    // llenar.
    if (type === "file") {
      return { ok: false, error: `${dónde}: todavía no se pueden pedir archivos dentro de una lista; sácalo de la lista` };
    }
    // Una matrix pone un `name` por FILA (`campo__0`) para agrupar sus radios. Repetida N
    // veces habría que reescribir también esos nombres al reordenar, y una rejilla dentro
    // de una lista es una pregunta que en la práctica nadie hace.
    if (type === "matrix") {
      return { ok: false, error: `${dónde}: una matrix no va dentro de una lista; usa select o radio` };
    }
    if (f?.section) return { ok: false, error: `${dónde}: los subcampos no llevan section (el paso lo define la lista)` };
  }

  let showIf: FormField["showIf"];
  if (f?.showIf) {
    const dep = String(f.showIf.field ?? "");
    // Sólo hacia atrás: si dependiera de un campo posterior, el paso donde se decide
    // aún no existe y el campo quedaría oculto para siempre.
    if (!names.has(dep) || dep === name) {
      return { ok: false, error: `${dónde} depende de "${dep}", que no está definido antes` };
    }
    showIf = { field: dep, equals: String(f.showIf.equals ?? "") };
  }

  let subs: FormField[] | undefined;
  let min: number | undefined;
  let max: number | undefined;
  if (type === "group") {
    const rawSubs = Array.isArray(f?.fields) ? f!.fields! : [];
    if (!rawSubs.length) return { ok: false, error: `${dónde} es una lista y no trae fields (los subcampos que se repiten)` };
    subs = [];
    // Scope propio para los `showIf` internos: un subcampo sólo puede depender de otro
    // subcampo del MISMO elemento. Cruzar la frontera no tiene semántica —¿el elemento 3
    // miraría el valor de la raíz o el del elemento 1?— así que no se permite.
    const scope = new Set<string>();
    for (const sub of rawSubs) {
      const r = parseField(sub, names, name);
      if (!r.ok) return r;
      if (r.field.showIf && !scope.has(r.field.showIf.field)) {
        return {
          ok: false,
          error: `"${name}" → "${r.field.name}" depende de "${r.field.showIf.field}", que no es otro subcampo suyo anterior`,
        };
      }
      scope.add(r.field.name);
      subs.push(r.field);
    }
    max = Math.min(GROUP_MAX, Math.max(1, Number(f?.max) || GROUP_DEFAULT_MAX));
    const m = Number(f?.min);
    if (Number.isFinite(m) && m > 0) min = Math.min(Math.floor(m), max);
  }

  return {
    ok: true,
    field: {
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
      ...(subs ? { fields: subs } : {}),
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      ...(f?.itemLabel ? { itemLabel: String(f.itemLabel) } : {}),
    },
  };
}
