/**
 * Variables del mensaje base: `{negocio}`, `{sitio}`, `{giro}` y cualquier columna de la lista
 * por su llave, con respaldo opcional `{negocio|tu equipo}`.
 *
 * Es lo que lemlist llama «custom variables» e Instantly «personalization tags»: el mensaje base
 * deja de ser idéntico para todos sin pagar un turno del agente por fila. Lo caro (investigar y
 * escribir una línea propia por prospecto) sigue siendo la columna `pitch`; esto es lo barato.
 *
 * Puro: sin imports de servidor, para usarlo igual en la vista previa del navegador y al mandar.
 */

export type VarRow = {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  address?: string | null;
  category?: string | null;
  data?: Record<string, { v?: string | null } | undefined>;
};

export type VarColumn = { key: string; label: string };

/** Las de siempre, con nombre en español porque es lo que la persona escribe. */
const BASE_VARS: { name: string; field: keyof VarRow; label: string }[] = [
  { name: "negocio", field: "name", label: "Negocio" },
  { name: "sitio", field: "website", label: "Sitio web" },
  { name: "giro", field: "category", label: "Giro" },
  { name: "telefono", field: "phone", label: "Teléfono" },
  { name: "correo", field: "email", label: "Correo" },
  { name: "direccion", field: "address", label: "Dirección" },
];

const VAR_RE = /\{([a-z0-9_]+)(?:\|([^}]*))?\}/gi;

/** La evidencia que pega el agente («digital https://…») no va dentro de un correo. */
function clean(v: string): string {
  return v.replace(/\s*https?:\/\/\S+/gi, "").trim();
}

/** Un sitio se escribe como lo diría una persona: `duplimedios.com`, no `https://WWW.DUPLIMEDIOS.COM/`. */
function prettySite(v: string): string {
  return v.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "").toLowerCase();
}

/** Los negocios del directorio vienen en MAYÚSCULAS: «DUPLIMEDIOS» se lee como grito. */
function prettyName(v: string): string {
  const s = v.trim();
  if (s !== s.toUpperCase() || !/[A-ZÁÉÍÓÚÑ]/.test(s)) return s;
  const keep = new Set(["SA", "CV", "SC", "S.A.", "C.V.", "IT", "TI", "MX"]);
  return s
    .toLowerCase()
    .split(/(\s+)/)
    .map((w) => (keep.has(w.toUpperCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join("");
}

function valueFor(name: string, row: VarRow, columns: VarColumn[]): string {
  const base = BASE_VARS.find((b) => b.name === name);
  if (base) {
    const raw = String(row[base.field] ?? "").trim();
    if (!raw) return "";
    if (base.name === "sitio") return prettySite(raw);
    if (base.name === "negocio") return prettyName(raw);
    return raw;
  }
  const col = columns.find((c) => c.key.toLowerCase() === name);
  return col ? clean(String(row.data?.[col.key]?.v ?? "")) : "";
}

/** Llena las variables de UNA fila. Una variable sin dato toma su respaldo (o desaparece). */
export function fillVars(text: string, row: VarRow, columns: VarColumn[] = []): string {
  return text
    .replace(VAR_RE, (_m, name: string, fallback?: string) => valueFor(name.toLowerCase(), row, columns) || (fallback ?? "").trim())
    .replace(/[ \t]{2,}/g, " ");
}

/** Las variables que se pueden insertar en esta lista, para los chips del editor. */
export function listVars(columns: VarColumn[]): { name: string; label: string }[] {
  return [
    ...BASE_VARS.map((b) => ({ name: b.name, label: b.label })),
    ...columns.filter((c) => /^[a-z0-9_]+$/i.test(c.key)).map((c) => ({ name: c.key.toLowerCase(), label: c.label })),
  ];
}

/** Cuántas filas se quedarían sin dato en cada variable del texto (sin contar las que tienen respaldo). */
export function missingVars(text: string, rows: VarRow[], columns: VarColumn[] = []): { name: string; missing: number; hasFallback: boolean }[] {
  const seen = new Map<string, boolean>();
  for (const m of text.matchAll(VAR_RE)) {
    const n = m[1].toLowerCase();
    seen.set(n, (seen.get(n) ?? false) || m[2] !== undefined);
  }
  return [...seen.entries()].map(([name, hasFallback]) => ({
    name,
    hasFallback,
    missing: rows.filter((r) => !valueFor(name, r, columns)).length,
  }));
}

/** ¿El texto usa variables? (para no recorrer filas cuando no hace falta) */
export function hasVars(text: string): boolean {
  return /\{[a-z0-9_]+(?:\|[^}]*)?\}/i.test(text);
}
