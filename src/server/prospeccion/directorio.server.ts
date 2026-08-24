/**
 * El directorio nacional de negocios — la fuente propia.
 *
 * ⚠️ Es el PRIMER dato COMPARTIDO entre workspaces de todo el sistema. Hasta ahora cada
 * namespace de sqld era una isla, y el comentario de cabecera de `sources/index.ts` decía
 * —con razón— que no había catálogo compartido. Esto lo cambia a propósito, y la frontera
 * es ésta:
 *
 *   · AQUÍ viven **hechos públicos del negocio**: el volcado oficial y lo que scrapeamos
 *     de su sitio público. Enriquecer una vez sirve a todos, que es exactamente lo que
 *     hace valioso a un motor de prospección.
 *   · NUNCA vive aquí el **trabajo de un cliente**: sus notas, su estado, su segmentación,
 *     a quién ya tocó, qué le contestaron. Eso se queda en las filas de SU namespace.
 *
 * Si algo no pasa esa prueba, va en el namespace del tenant aunque sea más incómodo.
 *
 * POR QUÉ NO LA API DEL PROVEEDOR, que era lo que había: topa a ~100 resultados, limita el
 * radio a 5 km, exige un token cuyo registro está roto en su propio sitio, y **casi nunca
 * devuelve correo**. El volcado masivo no pide token, no tiene tope y trae más columnas.
 * Medido sobre Ciudad de México (462,520 establecimientos cargados): **22.6% traen correo**
 * y **100% traen coordenadas**.
 */
import { tokenPara } from "../../dbq.server";
import type { Found } from "./sources/index";

/** Fijo: este namespace no depende del tenant. Es el punto entero. */
const NAMESPACE = "directorio";
const SQLD_URL = process.env.SQLD_URL ?? "http://127.0.0.1:8080";

type Cell = { value?: unknown };

/**
 * Consulta contra el namespace compartido.
 *
 * ⚠️ NO usa `dbq()`. Ése resuelve el namespace por el subdominio de la petición
 * (`currentNamespace()`), que es justo lo que aquí NO se quiere: el directorio es el mismo
 * para todos. Usarlo habría mandado la consulta al namespace del tenant, donde la tabla no
 * existe — y "no such table" se lee como "falta la migración", no como "namespace
 * equivocado".
 */
async function query(sql: string, args: unknown[] = []): Promise<Record<string, string | null>[]> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-namespace": NAMESPACE,
  };
  const token = tokenPara(NAMESPACE);
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${SQLD_URL}/v2/pipeline`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      requests: [
        {
          type: "execute",
          stmt: {
            sql,
            args: args.map((v) =>
              v === null || v === undefined
                ? { type: "null" }
                : typeof v === "number"
                  // ⚠️ Entero como TEXTO y flotante como NÚMERO: es lo que pide hrana. Al
                  // revés da `invalid type: string "19.41", expected f64`.
                  ? Number.isInteger(v)
                    ? { type: "integer", value: String(v) }
                    : { type: "float", value: v }
                  : { type: "text", value: String(v) }
            ),
          },
        },
        { type: "close" },
      ],
    }),
  });
  if (!res.ok) throw new Error(`directorio ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as {
    results: { type: string; error?: { message: string }; response?: { result: { cols: { name: string }[]; rows: Cell[][] } } }[];
  };
  const first = data.results[0];
  if (!first || first.type === "error") throw new Error(`directorio: ${first?.error?.message ?? "error"}`);
  const r = first.response!.result;
  const cols = r.cols.map((c) => c.name);
  return r.rows.map((row) => Object.fromEntries(cols.map((c, i) => [c, row[i]?.value == null ? null : String(row[i]!.value)])));
}

/** ¿Está cargado el directorio? Se usa para no prometer una búsqueda que no puede correr. */
export async function directorioListo(): Promise<boolean> {
  try {
    const r = await query(`SELECT COUNT(*) AS n FROM negocios LIMIT 1`);
    return Number(r[0]?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Grados de latitud/longitud que cubren N metros.
 *
 * La caja se calcula ANTES de la consulta para que el índice `(lat, lon)` pueda usarse: un
 * filtro con la distancia real dentro del WHERE obliga a recorrer los 5.5 millones. Se
 * acota con la caja —que el índice sí resuelve— y la distancia exacta se aplica después,
 * sobre los pocos que quedaron.
 */
function box(lat: number, lng: number, meters: number) {
  const dLat = meters / 111_320;
  const dLng = meters / (111_320 * Math.cos((lat * Math.PI) / 180) || 1);
  return { minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng };
}

/** Distancia en metros. Haversine, que a estas escalas sobra y es barata. */
function distance(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000;
  const p = Math.PI / 180;
  const h =
    0.5 - Math.cos((bLat - aLat) * p) / 2 +
    (Math.cos(aLat * p) * Math.cos(bLat * p) * (1 - Math.cos((bLng - aLng) * p))) / 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export type DirectorioQuery = {
  /** Qué se busca, en palabras. Va contra el índice de texto de nombre y actividad. */
  what: string;
  lat: number;
  lng: number;
  radius: number;
  limit: number;
  /** Sólo los que traen correo. Es el filtro que más cambia el rendimiento de una lista. */
  soloConCorreo?: boolean;
};

/**
 * Busca negocios.
 *
 * El QUÉ va por el índice de texto y el DÓNDE por la caja geográfica. Los dos filtros se
 * aplican en SQL; ordenar por distancia se hace aquí porque SQLite no tiene la función y
 * calcularla en SQL impediría usar el índice.
 */
export async function buscarDirectorio(q: DirectorioQuery): Promise<Found[]> {
  const b = box(q.lat, q.lng, q.radius);
  // Se piden más de los que se van a devolver: el orden de SQLite no es por distancia, así
  // que recortar antes de ordenar dejaría fuera a los más cercanos.
  const pool = Math.min(Math.max(q.limit * 6, 300), 3000);

  const terms = q.what.trim();
  const conTexto = terms.length > 1;
  // `fts5` con prefijo: "dentista" encuentra "dentistas". Las comillas evitan que un
  // apóstrofo o un guión del criterio se lea como sintaxis de consulta.
  const match = terms.split(/\s+/).map((t) => `"${t.replace(/"/g, "")}"*`).join(" ");

  const where = [
    "n.lat BETWEEN ? AND ?",
    "n.lon BETWEEN ? AND ?",
    q.soloConCorreo ? "n.email IS NOT NULL" : null,
  ].filter(Boolean).join(" AND ");

  const sql = conTexto
    ? `SELECT n.* FROM negocios_fts f JOIN negocios n ON n.rowid = f.rowid
       WHERE negocios_fts MATCH ? AND ${where} LIMIT ?`
    : `SELECT n.* FROM negocios n WHERE ${where} LIMIT ?`;
  const args = conTexto
    ? [match, b.minLat, b.maxLat, b.minLng, b.maxLng, pool]
    : [b.minLat, b.maxLat, b.minLng, b.maxLng, pool];

  const rows = await query(sql, args);

  return rows
    .map((r) => ({ r, d: distance(q.lat, q.lng, Number(r.lat), Number(r.lon)) }))
    .filter((x) => x.d <= q.radius)
    .sort((a, b2) => a.d - b2.d)
    .slice(0, q.limit)
    .map(({ r }) => toFound(r));
}

/** Cuántos hay que cumplan el criterio. Es lo que permite decir "hay 3,400" antes de traerlos. */
export async function contarDirectorio(q: Omit<DirectorioQuery, "limit">): Promise<number> {
  const b = box(q.lat, q.lng, q.radius);
  const terms = q.what.trim();
  const conTexto = terms.length > 1;
  const match = terms.split(/\s+/).map((t) => `"${t.replace(/"/g, "")}"*`).join(" ");
  const where = [
    "n.lat BETWEEN ? AND ?",
    "n.lon BETWEEN ? AND ?",
    q.soloConCorreo ? "n.email IS NOT NULL" : null,
  ].filter(Boolean).join(" AND ");
  const sql = conTexto
    ? `SELECT COUNT(*) AS n FROM negocios_fts f JOIN negocios n ON n.rowid = f.rowid WHERE negocios_fts MATCH ? AND ${where}`
    : `SELECT COUNT(*) AS n FROM negocios n WHERE ${where}`;
  const args = conTexto ? [match, b.minLat, b.maxLat, b.minLng, b.maxLng] : [b.minLat, b.maxLat, b.minLng, b.maxLng];
  const r = await query(sql, args);
  return Number(r[0]?.n ?? 0);
}

export type Zona = { nombre: string; tipo: string; entidad: string | null; lat: number; lon: number };

/**
 * El lugar que nombra el criterio, buscado entre los lugares REALES del directorio.
 *
 * Se prueba cada n-grama del texto contra la tabla `zonas` en UNA consulta. Gana el
 * nombre más LARGO —«San Pedro Garza García» antes que «San Pedro»— y, a igual largo, el
 * que tiene más negocios: «León» es municipio de Guanajuato y colonia en otras entidades,
 * y quien escribe «León» casi siempre habla del municipio.
 *
 * ⚠️ Devuelve `null` cuando no reconoce nada, y eso es la mitad del valor. Lo que había
 * antes caía a Ciudad de México en silencio: «dentistas en Torreón» devolvía dentistas de
 * la CDMX y no había forma de notarlo mirando el resultado.
 */
export async function buscarZona(texto: string): Promise<Zona | null> {
  const words = texto.split(/\s+/).filter(Boolean);
  if (!words.length) return null;

  // n-gramas de hasta 4 palabras: cubre «San Pedro Garza García» sin explotar la consulta.
  const grams = new Set<string>();
  for (let n = Math.min(4, words.length); n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) grams.add(words.slice(i, i + n).join(" "));
  }
  const list = [...grams];
  const placeholders = list.map(() => "?").join(",");

  // La comparación va SIN ACENTOS de los dos lados: en la base los nombres están
  // acentuados («Álvaro Obregón», «Mérida») y nadie los escribe así en un buscador.
  const rows = await query(
    `SELECT nombre, tipo, entidad, lat, lon, negocios
     FROM zonas
     WHERE lower(replace(replace(replace(replace(replace(nombre,'á','a'),'é','e'),'í','i'),'ó','o'),'ú','u')) IN (${placeholders})
     ORDER BY length(nombre) DESC, negocios DESC
     LIMIT 1`,
    list
  );
  const r = rows[0];
  if (!r) return null;
  return {
    nombre: r.nombre ?? "",
    tipo: r.tipo ?? "municipio",
    entidad: r.entidad,
    lat: Number(r.lat),
    lon: Number(r.lon),
  };
}

function limpio(v: string | null): string | null {
  const s = (v ?? "").trim();
  return s && s !== "0" ? s : null;
}

/** Teléfono a 10 dígitos con el formato que usa el resto del módulo. */
function telefono(v: string | null): string | null {
  const d = (v ?? "").replace(/\D/g, "");
  if (d.length < 10) return null;
  return d.slice(-10).replace(/(\d{2})(\d{4})(\d{4})/, "$1 $2 $3");
}

function sitio(v: string | null): string | null {
  const s = limpio(v);
  if (!s) return null;
  return s.startsWith("http") ? s : `https://${s}`;
}

function toFound(r: Record<string, string | null>): Found {
  const direccion = [
    [limpio(r.calle), limpio(r.num_ext), limpio(r.num_int) ? `int. ${limpio(r.num_int)}` : null].filter(Boolean).join(" "),
    limpio(r.colonia),
    limpio(r.municipio),
    limpio(r.entidad),
    limpio(r.cp),
  ].filter(Boolean).join(", ");

  const cells: NonNullable<Found["data"]> = {};
  const set = (k: string, v: string | null) => {
    if (v) cells[k] = { v, src: "directorio", verified: true };
  };
  set("tamano", limpio(r.empleados));
  set("sector", sectorLabel(r.sector));
  set("antiguedad", antiguedad(r.alta));
  set("lat", limpio(r.lat));
  set("lon", limpio(r.lon));

  return {
    name: limpio(r.nombre) ?? limpio(r.razon_social) ?? "",
    phone: telefono(r.telefono),
    // ⚠️ En minúsculas: el volcado los trae TODOS EN MAYÚSCULAS y así llegarían al envío,
    // a la deduplicación y a la lista de bajas, donde el mismo correo en dos cajas es dos
    // correos distintos.
    email: limpio(r.email)?.toLowerCase() ?? null,
    website: sitio(r.website),
    address: direccion || null,
    category: limpio(r.actividad),
    data: Object.keys(cells).length ? cells : undefined,
  };
}

/**
 * El nombre del sector a partir de los 2 dígitos del clasificador.
 *
 * ⚠️ La tabla vive SÓLO aquí: en la base se guardan los dígitos, no la etiqueta. Guardar
 * el texto en 5.5 millones de filas obliga a recargar todo para corregir una palabra, y
 * garantiza que la copia de la base y la del código acaben diciendo cosas distintas.
 */
const SECTORS: Record<string, string> = {
  "11": "Agricultura y ganadería", "21": "Minería", "22": "Energía y agua",
  "23": "Construcción", "31": "Manufactura", "32": "Manufactura", "33": "Manufactura",
  "43": "Comercio al por mayor", "46": "Comercio al por menor", "47": "Comercio al por menor",
  "48": "Transporte", "49": "Transporte", "51": "Medios y telecomunicaciones",
  "52": "Servicios financieros", "53": "Inmobiliaria y alquiler",
  "54": "Servicios profesionales", "55": "Corporativos", "56": "Servicios de apoyo a negocios",
  "61": "Educación", "62": "Salud", "71": "Cultura y deporte",
  "72": "Hoteles y restaurantes", "81": "Otros servicios", "93": "Gobierno",
};

export function sectorLabel(code: string | null): string | null {
  return SECTORS[(code ?? "").slice(0, 2)] ?? null;
}

/**
 * Años desde el alta en el directorio.
 *
 * NO es la edad del negocio y la etiqueta de la columna no lo promete: es desde cuándo
 * está censado. Aun así separa al changarro de este año del que lleva quince.
 */
export function antiguedad(alta: string | null): string | null {
  const y = Number((alta ?? "").match(/\b(19|20)\d{2}\b/)?.[0]);
  if (!y) return null;
  const n = new Date().getFullYear() - y;
  return n < 0 || n > 60 ? null : String(n);
}
