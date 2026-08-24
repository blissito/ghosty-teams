/**
 * Filtros de una lista de prospección.
 *
 * ISOMORFO: la barra los pinta, el servidor los aplica, y el agente los produce. Si cada
 * uno tuviera su propia idea de qué significa «sin teléfono», la barra enseñaría 312 filas
 * y el envío saldría a otras.
 *
 * ⚠️ La regla que sostiene todo: **la unidad de trabajo es la VISTA, no la lista.**
 * Enriquecer, redactar y mandar aplican a lo que está filtrado, no a las 10,728 filas. Sin
 * esto no se puede hacer lo más normal del mundo — «a las que no tienen teléfono, búscales
 * el teléfono».
 */

export type Condition =
  /** El texto aparece en cualquier columna. Es el filtro que la gente usa primero. */
  | { op: "text"; value: string }
  /** Una columna está vacía. «sin teléfono», «sin correo». */
  | { op: "empty"; field: string }
  /** Una columna tiene algo. */
  | { op: "filled"; field: string }
  /** Una columna contiene esto. */
  | { op: "has"; field: string; value: string }
  /** Estado en el embudo. */
  | { op: "status"; value: string }
  /** Temperatura: frío · tibio · caliente. Se deriva del estado. */
  | { op: "temp"; value: TempId };

export type Filter = Condition[];

/** Los estados del embudo, con su nombre en la interfaz. */
export const STATUSES: { id: string; label: string }[] = [
  { id: "new", label: "Sin tocar" },
  { id: "sent", label: "Mandado" },
  { id: "opened", label: "Abrió" },
  { id: "clicked", label: "Dio clic" },
  { id: "replied", label: "Contestó" },
  { id: "bounced", label: "Rebotó" },
  { id: "optout", label: "Dado de baja" },
];

/**
 * La TEMPERATURA de un prospecto — el vocabulario estándar de prospección.
 *
 * No es una etiqueta nueva ni un dato que haya que guardar: se DERIVA del estado que ya se
 * mide. Existe porque «MANDADOS · ABRIERON · CONTESTARON» nombra el mecanismo y la
 * temperatura nombra lo que hay que hacer con cada uno.
 *
 * ⚠️ Y no es cosmética: la frontera tibio→caliente es exactamente la **ventana de 24h de
 * WhatsApp**. A un caliente se le puede contestar libre porque él escribió primero; a un
 * frío sólo con plantilla aprobada, y masivo eso quema el número. Confundirlos es el error
 * caro de este módulo.
 */
export type TempId = "frio" | "tibio" | "caliente";

export const TEMPS: { id: TempId; label: string; hint: string }[] = [
  { id: "frio", label: "Frío", hint: "Nunca ha tenido contacto contigo" },
  { id: "tibio", label: "Tibio", hint: "Dio una señal: abrió o dio clic" },
  { id: "caliente", label: "Caliente", hint: "Te escribió él: se le puede contestar libre" },
];

/** Qué estados cuentan como cada temperatura. Lo demás (baja, rebote) no tiene. */
const TEMP_DE: Record<string, TempId> = {
  new: "frio",
  sent: "frio",   // que salga el correo no lo entibia: entibia que él REACCIONE
  opened: "tibio",
  clicked: "tibio",
  replied: "caliente",
};

/** La temperatura de una fila, o null si su estado no tiene ninguna (baja, rebote). */
export function tempOf(row: Record<string, unknown>): TempId | null {
  return TEMP_DE[String(row.status ?? "new")] ?? null;
}

const BASE_FIELDS = new Set(["name", "phone", "email", "website", "address", "category"]);

/** El valor de un campo en una fila, sea columna base o dinámica. */
export function valueOf(row: Record<string, unknown>, field: string): string {
  if (BASE_FIELDS.has(field)) return String(row[field] ?? "");
  const data = row.data as Record<string, { v?: string | null }> | undefined;
  return String(data?.[field]?.v ?? "");
}

function norm(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** ¿Esta fila pasa el filtro? Todas las condiciones se suman (Y, no O). */
export function matches(row: Record<string, unknown>, filter: Filter, fields: string[]): boolean {
  for (const c of filter) {
    switch (c.op) {
      case "text": {
        const needle = norm(c.value);
        if (!needle) break;
        if (!fields.some((f) => norm(valueOf(row, f)).includes(needle))) return false;
        break;
      }
      case "empty":
        if (valueOf(row, c.field).trim()) return false;
        break;
      case "filled":
        if (!valueOf(row, c.field).trim()) return false;
        break;
      case "has":
        if (!norm(valueOf(row, c.field)).includes(norm(c.value))) return false;
        break;
      case "status":
        if (String(row.status ?? "new") !== c.value) return false;
        break;
      case "temp":
        if (tempOf(row) !== c.value) return false;
        break;
    }
  }
  return true;
}

/**
 * Cómo se lee una condición en un chip.
 *
 * En palabras y no en símbolos: «sin Teléfono» se entiende, `phone = ∅` no. El chip es la
 * prueba de que el agente entendió lo que se le pidió, así que tiene que poder leerse de un
 * vistazo y sin aprender nada.
 */
export function describe(c: Condition, labelOf: (field: string) => string): string {
  switch (c.op) {
    case "text": return `«${c.value}»`;
    case "empty": return `sin ${labelOf(c.field)}`;
    case "filled": return `con ${labelOf(c.field)}`;
    case "has": return `${labelOf(c.field)}: ${c.value}`;
    case "status": return STATUSES.find((s) => s.id === c.value)?.label ?? c.value;
    case "temp": return TEMPS.find((x) => x.id === c.value)?.label ?? c.value;
  }
}

/**
 * El filtro viaja en la URL como UNA clave opaca (base64url de su JSON).
 *
 * ⚠️ Una clave por condición sería más legible, pero el filtro es de largo variable y con
 * formas distintas por operador — no hay un juego fijo de claves que lo represente. Y el
 * router parsea los search params **como JSON**: `?q=1` llega como número, `?q=a,b` como
 * string. Un string opaco es lo único que no se le deforma.
 *
 * Que quepa en la URL es lo que permite COMPARTIR una vista («mira estos 40») y que volver
 * atrás no la pierda.
 */
export function encodeFilter(f: Filter): string | undefined {
  if (!f.length) return undefined;
  const json = JSON.stringify(f);
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = typeof btoa === "function" ? btoa(bin) : Buffer.from(json, "utf8").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeFilter(s: unknown): Filter {
  if (typeof s !== "string" || !s) return [];
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    let json: string;
    if (typeof atob === "function") {
      const bin = atob(b64);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      json = new TextDecoder().decode(bytes);
    } else {
      json = Buffer.from(b64, "base64").toString("utf8");
    }
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as Filter) : [];
  } catch {
    // Una URL manoseada no rompe la pantalla: se ve la lista entera.
    return [];
  }
}

/** Una condición igual a otra. Para no meter el mismo chip dos veces. */
export function sameCondition(a: Condition, b: Condition): boolean {
  if (a.op !== b.op) return false;
  const fa = "field" in a ? a.field : "";
  const fb = "field" in b ? b.field : "";
  const va = "value" in a ? norm(a.value) : "";
  const vb = "value" in b ? norm(b.value) : "";
  return fa === fb && va === vb;
}
