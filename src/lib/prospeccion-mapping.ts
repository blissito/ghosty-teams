/**
 * Mapeo de encabezados de una hoja a las columnas de una lista de prospección.
 *
 * ISOMORFO a propósito, como `form-fields.ts`: el navegador lo usa para ENSEÑAR lo que
 * entendió antes de importar, y el servidor para aplicarlo. Si el mapeo viviera sólo en el
 * servidor, la pantalla de revisión tendría que adivinarlo otra vez y las dos podrían no
 * coincidir — que es justo lo que la revisión existe para evitar.
 */

/** Las columnas fijas de toda fila, en el orden en que se muestran. */
export const BASE_COLUMNS: { key: string; label: string }[] = [
  { key: "name", label: "Negocio" },
  { key: "phone", label: "Teléfono" },
  { key: "email", label: "Correo" },
  { key: "website", label: "Sitio web" },
  { key: "address", label: "Dirección" },
  { key: "category", label: "Giro" },
];

/** Sinónimos por columna base. Se compara sin acentos, en minúsculas y sin signos. */
const SYNONYMS: Record<string, string[]> = {
  name: ["nombre", "negocio", "empresa", "razon social", "compania", "company", "business", "name", "establecimiento", "cliente"],
  // ⚠️ "numero" a secas NO está: colisiona con "Número de empleados", que es una columna
  // habitual en una hoja de prospectos. "Número de teléfono" cruza igual por la pasada laxa.
  phone: ["telefono", "tel", "celular", "movil", "whatsapp", "wa", "phone", "mobile", "contacto telefonico"],
  email: ["correo", "email", "e mail", "correo electronico", "mail"],
  website: ["sitio", "sitio web", "web", "pagina", "pagina web", "url", "website", "dominio"],
  address: ["direccion", "domicilio", "ubicacion", "address", "calle"],
  category: ["giro", "categoria", "rubro", "actividad", "sector", "category", "industria"],
};

export function normalizeHeader(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Slug estable para la llave de una columna. Sin acentos ni espacios: va en JSON y en el DOM. */
export function columnKey(label: string): string {
  const base = normalizeHeader(label).replace(/ /g, "_").slice(0, 40);
  return base || `col_${Date.now().toString(36)}`;
}

/** A qué columna base corresponde este encabezado, si a alguna. */
export function mapHeader(header: string): string | null {
  const h = normalizeHeader(header);
  if (!h) return null;

  for (const [base, aliases] of Object.entries(SYNONYMS)) {
    if (aliases.includes(h)) return base;
  }
  // Segunda pasada: alguna PALABRA del encabezado es un sinónimo exacto. Cubre los casos
  // cortos que la tercera no puede tocar sin falsos positivos — "Tel. de contacto" →
  // ["tel","de","contacto"], y "tel" es sinónimo; buscarlo como subcadena haría que "Total"
  // cruzara como teléfono.
  const words = h.split(" ");
  for (const [base, aliases] of Object.entries(SYNONYMS)) {
    if (words.some((w) => aliases.includes(w))) return base;
  }
  // Tercera pasada, laxa: "Teléfono de contacto" contiene "telefono". Sólo sinónimos largos.
  for (const [base, aliases] of Object.entries(SYNONYMS)) {
    if (aliases.some((a) => a.length > 3 && h.includes(a))) return base;
  }
  return null;
}

/**
 * ¿La primera fila es cabecera o ya son datos?
 *
 * Si ningún encabezado reconoce una columna Y alguno parece un teléfono o un correo,
 * entonces no es cabecera: es la primera fila de datos. Sin esto, una hoja sin encabezados
 * se come el primer prospecto en silencio.
 */
export function looksLikeHeader(headers: string[]): boolean {
  if (headers.some((h) => mapHeader(h))) return true;
  const looksLikeData = headers.some((h) => /@/.test(h) || /^\+?[\d\s()-]{10,}$/.test(h.trim()));
  return !looksLikeData;
}

/** Destino de una columna de la hoja: una columna base, una nueva, o descartarla. */
export type Target = string | "__new__" | "__skip__";

export type Plan = {
  /** Los encabezados finales (si la hoja no traía, se generan). */
  headers: string[];
  /** Las filas, ya recolocadas si la primera era datos. */
  rows: string[][];
  /** header → destino. */
  targets: Record<string, Target>;
};

/**
 * Propone el plan de importación: qué va a dónde.
 *
 * Es lo que se le enseña a la persona ANTES de escribir nada. Que sea una propuesta y no
 * una decisión es el punto: el auto-mapeo acierta casi siempre, y cuando falla, después de
 * importar ya no hay forma de darse cuenta.
 */
export function planImport(rawHeaders: string[], rawRows: string[][]): Plan {
  let headers = rawHeaders;
  let rows = rawRows;

  if (!looksLikeHeader(headers)) {
    rows = [headers, ...rows];
    headers = headers.map((_, i) => `Columna ${i + 1}`);
  }

  const targets: Record<string, Target> = {};
  const taken = new Set<string>();
  for (const h of headers) {
    const base = mapHeader(h);
    // Una sola columna por campo base: si la hoja trae "Teléfono" y "Celular", la primera
    // gana y la segunda se propone como columna nueva en vez de pisarla.
    if (base && !taken.has(base)) {
      targets[h] = base;
      taken.add(base);
    } else {
      targets[h] = "__new__";
    }
  }
  return { headers, rows, targets };
}
