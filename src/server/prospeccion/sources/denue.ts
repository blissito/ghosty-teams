/**
 * DENUE (INEGI) — el directorio de unidades económicas de México.
 *
 * Por qué es la primera fuente: es API oficial, gratis, sin proxy ni scraping, cubre ~6
 * millones de establecimientos y trae giro, tamaño y ubicación. Google Maps da más
 * señales (reseñas, sitio web) pero exige proxy residencial; ése es el segundo adaptador.
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
  Colonia?: string;
  Ubicacion?: string;
  Estrato?: string;
};

/** Arma la dirección legible a partir de los pedazos que DENUE devuelve sueltos. */
function buildAddress(r: DenueRaw): string | null {
  const parts = [
    [r.Tipo_vialidad, r.Calle].filter(Boolean).join(" "),
    r.Num_Exterior,
    r.Colonia,
    r.Ubicacion,
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

export const denue: SearchSource = {
  id: "denue",
  label: "DENUE (INEGI)",
  blurb: "Directorio oficial de ~6 millones de negocios en México. Da fileName, giro, teléfono y dirección. Casi nunca da correo.",

  async search(criteria, limit) {
    const token = TOKEN();
    if (!token) throw new Error("Falta DENUE_TOKEN. Se pide gratis en inegi.org.mx/servicios/api_denue.html");

    const { what, zone } = parseCriteria(criteria);
    const url =
      `https://www.inegi.org.mx/app/api/denue/v1/consulta/search/` +
      `${encodeURIComponent(what)}/${zone.lat},${zone.lng}/${zone.radius}/${token}`;

    const res = await fetch(url, { signal: AbortSignal.timeout(25_000) });
    if (!res.ok) throw new Error(`DENUE respondió ${res.status}`);

    // DENUE devuelve 200 con un array vacío cuando no hay nada, y a veces un objeto de
    // error con 200. Las dos formas se tratan igual: sin filas.
    const json = (await res.json().catch(() => null)) as DenueRaw[] | null;
    if (!Array.isArray(json)) return [];

    const out: Found[] = [];
    const seen = new Set<string>();
    for (const r of json) {
      const name = (r.Nombre || r.Razon_social || "").trim();
      if (!name) continue;
      // Dedup por fileName + dirección: DENUE repite la misma unidad con distinto id.
      const key = stripAccents(`${name}|${r.Calle ?? ""}${r.Num_Exterior ?? ""}`);
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        name,
        phone: cleanPhone(r.Telefono),
        email: (r.Correo_e ?? "").trim() || null,
        website: cleanWebsite(r.Sitio_internet),
        address: buildAddress(r),
        category: (r.Clase_actividad ?? "").trim() || null,
        data: r.Estrato ? { tamano: { v: r.Estrato, src: "denue", verified: true } } : undefined,
      });
      if (out.length >= limit) break;
    }
    return out;
  },
};
