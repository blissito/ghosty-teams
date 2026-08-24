/**
 * El directorio nacional de unidades económicas de México.
 *
 * Por qué es la primera fuente: es API oficial, gratis, sin proxy ni scraping, cubre ~6
 * millones de establecimientos y trae giro, tamaño y ubicación. Google Maps da más
 * señales (reseñas, sitio web) pero exige proxy residencial; ése es el segundo adaptador.
 *
 * ⚠️ QUÉ PROVEEDOR HAY DETRÁS NO SE DICE NUNCA hacia afuera — ni en la pantalla, ni en un
 * error, ni en el `blurb` que lee el agente. Es infraestructura nuestra: el usuario no
 * puede hacer nada con ese dato, y publicarlo regala el mapa de con quién trabajamos a
 * cualquiera que abra una cuenta. Dentro del código sí se nombra, que es donde sirve.
 *
 * El endpoint que usamos es `Buscar/<condición>/<lat>/<lng>/<radius>/<token>`: busca por
 * palabra en un radio. La alternativa `BuscarEntidad` filtra por estado y no por zona, y
 * la petición típica de un vendedor es una COLONIA, no un estado.
 *
 * ⚠️ DENUE no entrega correo electrónico casi nunca. Eso es esperado: el correo es una
 * columna de enriquecimiento posterior, no un dato de la fuente.
 */
import type { Found, SearchSource } from "./index";

const TOKEN = () => process.env.DENUE_TOKEN ?? "";

/**
 * Zonas conocidas con su centro. DENUE pide lat/lng, y una persona escribe "Polanco".
 *
 * Es deliberadamente una hoja corta y no un geocoder: cubre las zonas donde se está
 * vendiendo hoy y falla de forma visible fuera de ellas, que es mejor que un geocoder
 * que devuelve el centroide de la República y "no encuentra nada" sin decir por qué.
 */
const ZONES: Record<string, { lat: number; lng: number; radius: number }> = {
  polanco: { lat: 19.4333, lng: -99.1908, radius: 2000 },
  condesa: { lat: 19.4116, lng: -99.1738, radius: 2000 },
  roma: { lat: 19.4185, lng: -99.1605, radius: 2000 },
  coyoacan: { lat: 19.3467, lng: -99.1618, radius: 3000 },
  "santa fe": { lat: 19.3600, lng: -99.2600, radius: 3000 },
  satelite: { lat: 19.5093, lng: -99.2340, radius: 3000 },
  "del valle": { lat: 19.3860, lng: -99.1650, radius: 2500 },
  narvarte: { lat: 19.3930, lng: -99.1540, radius: 2000 },
  "cdmx": { lat: 19.4326, lng: -99.1332, radius: 8000 },
  guadalajara: { lat: 20.6597, lng: -103.3496, radius: 8000 },
  monterrey: { lat: 25.6866, lng: -100.3161, radius: 8000 },
  puebla: { lat: 19.0414, lng: -98.2063, radius: 6000 },
  queretaro: { lat: 20.5888, lng: -100.3899, radius: 6000 },
  merida: { lat: 20.9674, lng: -89.5926, radius: 6000 },
  tijuana: { lat: 32.5149, lng: -117.0382, radius: 8000 },
  cancun: { lat: 21.1619, lng: -86.8515, radius: 6000 },
};

/**
 * El radio que acepta la API, no el que pide la zona.
 *
 * ⚠️ El máximo documentado son **5,000 metros**. Media tabla de zonas pedía 6,000 u 8,000
 * (CDMX, Guadalajara, Monterrey, Tijuana) — justo las ciudades grandes, o sea las
 * búsquedas que más importan. Un parámetro fuera de rango no devuelve "lo ajusté": la
 * consulta se rechaza entera.
 *
 * Se topa aquí y no en la tabla para que los centros sigan diciendo la verdad sobre el
 * área que se quiso cubrir el día que se pueda barrer en varios círculos.
 */
const MAX_RADIUS = 5000;
function radiusOf(z: { radius: number }): number {
  return Math.min(z.radius, MAX_RADIUS);
}

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * Parte el criterio en QUÉ se busca y DÓNDE.
 *
 * No se le pide al modelo: es una separación mecánica y meterle un turno de agente a
 * cada búsqueda la haría lenta y cara sin ganar precisión.
 */
export function parseCriteria(criteria: string): { what: string; zone: { lat: number; lng: number; radius: number }; zoneName: string } {
  const clean = stripAccents(criteria);
  let zoneName = "cdmx";
  let best = 0;
  for (const fileName of Object.keys(ZONES)) {
    // Gana la coincidencia MÁS LARGA: "santa fe" antes que "fe" si alguna vez se agrega.
    if (clean.includes(fileName) && fileName.length > best) {
      zoneName = fileName;
      best = fileName.length;
    }
  }

  // El "qué" es el criterio sin la zona, sin números y sin las palabras de relleno.
  let what = clean
    .replace(new RegExp(`\\b${zoneName}\\b`, "g"), " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/\b(en|de|del|la|el|los|las|con|sin|what|un|una|por|para|cerca|zone|colonia|negocios?|empresas?)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!what) what = "negocio"; // término de búsqueda para DENUE: va EN ESPAÑOL, es su índice
  return { what, zone: ZONES[zoneName], zoneName };
}

/**
 * Lo que un establecimiento trae por respuesta.
 *
 * ⚠️ Los campos de abajo de `Estrato` estuvieron AUSENTES de este tipo hasta el 2026-08-24
 * y por eso se tiraban: la API los mandaba en cada respuesta y el mapeo no los miraba.
 * El más caro fue `Latitud`/`Longitud` — la rejilla YA sabe colapsar un par lat/lon en un
 * enlace al local (`Grid.tsx`, `findLatLon`), o sea que la función estaba construida
 * esperando un dato que se descartaba a la entrada.
 */
type DenueRaw = {
  Nombre?: string;
  Razon_social?: string;
  Clase_actividad?: string;
  Telefono?: string;
  Correo_e?: string;
  Sitio_internet?: string;
  Tipo_vialidad?: string;
  Calle?: string;
  Num_Exterior?: string;
  Num_Interior?: string;
  Colonia?: string;
  Ubicacion?: string;
  Estrato?: string;
  /** Clave estable del establecimiento. Es lo que permite dedupe ENTRE listas. */
  CLEE?: string;
  CP?: string;
  /** SCIAN a 6 dígitos. Los 2 primeros son el sector. */
  Codigo_Act?: string;
  /** "Mes Año" del alta en el directorio. Aproxima la antigüedad del negocio. */
  Fecha_Alta?: string;
  Latitud?: string;
  Longitud?: string;
};

/** Arma la dirección legible a partir de los pedazos que DENUE devuelve sueltos. */
function buildAddress(r: DenueRaw): string | null {
  const parts = [
    [r.Tipo_vialidad, r.Calle].filter(Boolean).join(" "),
    [r.Num_Exterior, r.Num_Interior ? `int. ${r.Num_Interior}` : ""].filter(Boolean).join(" "),
    r.Colonia,
    r.Ubicacion,
    r.CP,
  ]
    .map((p) => (p ?? "").trim())
    .filter((p) => p && p !== "0");
  return parts.length ? parts.join(", ") : null;
}

function cleanPhone(t: string | undefined): string | null {
  if (!t) return null;
  const d = t.replace(/\D/g, "");
  if (d.length < 10) return null;
  return d.slice(-10).replace(/(\d{2})(\d{4})(\d{4})/, "$1 $2 $3");
}

function cleanWebsite(s: string | undefined): string | null {
  const v = (s ?? "").trim();
  if (!v || v === "0") return null;
  return v.startsWith("http") ? v : `https://${v}`;
}


/**
 * Sector a partir del SCIAN.
 *
 * Los 2 primeros dígitos del código de actividad son el sector, y con eso 40 giros
 * distintos ("consultorios dentales", "consultorios de nutrición", "laboratorios") caen
 * en UN grupo. Es la única segmentación gruesa que se puede hacer sin gastar un turno de
 * modelo, y el giro en texto no sirve para agrupar: filtrar por `has` es substring.
 *
 * Los rangos son los oficiales del clasificador; varios sectores comparten grupo (31-33
 * es manufactura entera), por eso la tabla es por prefijo y no por número suelto.
 */
const SCIAN_SECTORS: [RegExp, string][] = [
  [/^11/, "Agricultura y ganadería"],
  [/^21/, "Minería"],
  [/^22/, "Energía y agua"],
  [/^23/, "Construcción"],
  [/^3[123]/, "Manufactura"],
  [/^43/, "Comercio al por mayor"],
  [/^4[6-7]/, "Comercio al por menor"],
  [/^4[89]/, "Transporte"],
  [/^51/, "Medios y telecomunicaciones"],
  [/^52/, "Servicios financieros"],
  [/^53/, "Inmobiliaria y alquiler"],
  [/^54/, "Servicios profesionales"],
  [/^55/, "Corporativos"],
  [/^56/, "Servicios de apoyo a negocios"],
  [/^61/, "Educación"],
  [/^62/, "Salud"],
  [/^71/, "Cultura y deporte"],
  [/^72/, "Hoteles y restaurantes"],
  [/^81/, "Otros servicios"],
  [/^93/, "Gobierno"],
];

export function sectorOf(code: string | undefined): string | null {
  const c = (code ?? "").replace(/\D/g, "");
  if (c.length < 2) return null;
  return SCIAN_SECTORS.find(([re]) => re.test(c))?.[1] ?? null;
}

/**
 * Años en el directorio, a partir de la fecha de alta ("Julio 2010").
 *
 * NO es la edad del negocio y la etiqueta de la columna no lo promete: es desde cuándo
 * está censado. Aun así separa al changarro de este año del que lleva quince, que es la
 * pregunta que de verdad se hace quien califica una lista.
 */
export function yearsListed(fecha: string | undefined): string | null {
  const y = Number((fecha ?? "").match(/\b(19|20)\d{2}\b/)?.[0]);
  if (!y) return null;
  const años = new Date().getFullYear() - y;
  return años < 0 || años > 60 ? null : String(años);
}

/** Un flotante que sirva como coordenada, o nada. `"0"` y `""` no son coordenadas. */
function coord(v: string | undefined, max: number): string | null {
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 && Math.abs(n) <= max ? String(n) : null;
}

/** Sólo las celdas con valor: una celda vacía ocupa columna y no dice nada. */
function cells(pairs: Record<string, string | null>): Record<string, { v: string; src: string; verified: boolean }> {
  const out: Record<string, { v: string; src: string; verified: boolean }> = {};
  for (const [k, v] of Object.entries(pairs)) {
    if (v) out[k] = { v, src: "directorio", verified: true };
  }
  return out;
}

/**
 * Un establecimiento crudo → una fila.
 *
 * Vive fuera de `search` para poder probarse sin red: el mapeo es donde se pierden los
 * datos en silencio (un campo que no está en el tipo se descarta y nada falla), así que es
 * justo la parte que necesita prueba con un ejemplo real delante.
 */
export function toFound(r: DenueRaw): Found | null {
  const name = (r.Nombre || r.Razon_social || "").trim();
  if (!name) return null;
  return {
    name,
    phone: cleanPhone(r.Telefono),
    email: (r.Correo_e ?? "").trim() || null,
    website: cleanWebsite(r.Sitio_internet),
    address: buildAddress(r),
    category: (r.Clase_actividad ?? "").trim() || null,
    data: cells({
      tamano: (r.Estrato ?? "").trim() || null,
      sector: sectorOf(r.Codigo_Act),
      antiguedad: yearsListed(r.Fecha_Alta),
      // La rejilla reconoce el par por su ETIQUETA y lo colapsa en un enlace al local.
      lat: coord(r.Latitud, 90),
      lon: coord(r.Longitud, 180),
    }),
  };
}

export const denue: SearchSource = {
  id: "denue",
  label: "Directorio de negocios de México",
  blurb:
    "Directorio de ~6 millones de negocios en México. Da nombre, giro, sector, teléfono, " +
    "dirección, ubicación en el mapa, tamaño y antigüedad. Casi nunca da correo: ése sale " +
    "después con la columna «Contacto del sitio».",

  /**
   * ⚠️ Las etiquetas de `lat`/`lon` importan: `findLatLon` (Grid.tsx) las reconoce POR
   * NOMBRE y las colapsa en un enlace al local en vez de pintar dos columnas de flotantes
   * que nadie lee. Cambiarlas por «Coordenada X» rompe esa función en silencio.
   */
  columns: [
    { key: "sector", label: "Sector" },
    { key: "tamano", label: "Tamaño" },
    { key: "antiguedad", label: "Años en el directorio" },
    { key: "lat", label: "Latitud" },
    { key: "lon", label: "Longitud" },
  ],

  async search(criteria, limit) {
    const token = TOKEN();
    if (!token) {
      // ⚠️ Lo que ve el usuario NO nombra la fuente ni la variable de entorno: es
      // infraestructura nuestra, no puede hacer nada con ese dato, y de paso le regala a
      // cualquiera con una cuenta el mapa de con qué proveedores trabajamos.
      // Lo accionable va al LOG, que es donde puede leerlo quien sí puede arreglarlo.
      console.warn("[prospeccion] falta DENUE_TOKEN — se pide gratis en inegi.org.mx/servicios/api_denue.html");
      throw new Error("La búsqueda de negocios todavía no está disponible en este workspace.");
    }

    const { what, zone } = parseCriteria(criteria);
    /**
     * ⚠️ El verbo es `Buscar`, en español y con mayúscula.
     *
     * Estuvo como `search` desde el principio y devuelve **404 con una página HTML** —
     * o sea que el buscador habría fallado igual con token. No se notó porque el token
     * tampoco existía: el error de la llave tapaba el de la ruta. Comprobado contra la
     * API viva el 2026-08-24; `BuscarEntidad` sí contesta JSON, que es lo que confirma
     * que el estilo de ruta son verbos en español y no que el servicio esté caído.
     */
    const url =
      `https://www.inegi.org.mx/app/api/denue/v1/consulta/Buscar/` +
      `${encodeURIComponent(what)}/${zone.lat},${zone.lng}/${radiusOf(zone)}/${token}`;

    const res = await fetch(url, { signal: AbortSignal.timeout(25_000) });
    if (!res.ok) {
      console.warn(`[prospeccion] DENUE respondió ${res.status}`);
      throw new Error("La búsqueda de negocios no respondió. Inténtalo en un momento.");
    }

    // DENUE devuelve 200 con un array vacío cuando no hay nada, y a veces un objeto de
    // error con 200. Las dos formas se tratan igual: sin filas.
    const json = (await res.json().catch(() => null)) as DenueRaw[] | null;
    if (!Array.isArray(json)) return [];

    const out: Found[] = [];
    const seen = new Set<string>();
    for (const r of json) {
      const row = toFound(r);
      if (!row) continue;
      // Dedup por la clave estable cuando viene; si no, por nombre + dirección, que es lo
      // que había: el directorio repite la misma unidad con distinto id interno.
      //
      // ⚠️ Esto dedupe DENTRO de una búsqueda, no ENTRE listas. Para lo segundo la clave
      // tiene que viajar hasta la fila y eso pide una columna en `gt_prosp_rows`; hoy dos
      // búsquedas parecidas siguen produciendo el mismo negocio dos veces, y el cooldown
      // de 7 días no las cruza porque es por `row_id`.
      const key = (r.CLEE ?? "").trim() || stripAccents(`${row.name}|${r.Calle ?? ""}${r.Num_Exterior ?? ""}`);
      if (seen.has(key)) continue;
      seen.add(key);

      out.push(row);
      if (out.length >= limit) break;
    }
    return out;
  },
};
