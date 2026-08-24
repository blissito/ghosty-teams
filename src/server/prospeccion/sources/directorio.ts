/**
 * La fuente por defecto: nuestro propio directorio nacional.
 *
 * Sustituye a la consulta en vivo contra la API del proveedor, que tenía cuatro techos y
 * ninguno se podía subir: ~100 resultados por consulta, radio máximo de 5 km, un token
 * cuyo registro está roto en el sitio del proveedor, y —lo que de verdad importaba— casi
 * nunca devolvía correo. El volcado masivo no pide token y trae **22.6% de correos**.
 *
 * ⚠️ El proveedor NO se nombra hacia afuera: ni en la pantalla, ni en un error, ni en el
 * `blurb` que lee el agente (ese texto acaba en el chat). Dentro del código sí.
 */
import { buscarDirectorio, contarDirectorio } from "../directorio.server";
import type { Found, SearchSource } from "./index";

/**
 * Radio por tipo de lugar.
 *
 * Una colonia es un barrio y un estado es medio país; usar el mismo radio para los dos
 * hace que buscar en una colonia arrastre a la ciudad entera. Ya no hay tope de 5 km: la
 * consulta es contra nuestra base.
 */
const RADIUS: Record<string, number> = {
  colonia: 2_500,
  municipio: 12_000,
  entidad: 90_000,
};

/** Palabras que no son ni el qué ni el dónde. Sacarlas mejora mucho el índice de texto. */
const STOPWORDS = /\b(en|de|del|la|el|los|las|con|sin|un|una|por|para|cerca|zona|colonia|municipio|estado|negocios?|empresas?|dame|busca|buscame|encuentra|quiero|todos?|todas?)\b/g;

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * Parte el criterio en QUÉ y DÓNDE, resolviendo el DÓNDE contra los lugares REALES.
 *
 * ⚠️ Antes esto era una hoja de 16 colonias escrita a mano y su modo de falla era mudo:
 * cualquier lugar fuera de la lista caía a Ciudad de México sin avisar, así que "dentistas
 * en Torreón" devolvía dentistas de la CDMX y el resultado se veía perfectamente
 * plausible. Ahora los lugares salen de los propios datos y, cuando no se reconoce
 * ninguno, **se dice** en vez de inventar un centro.
 *
 * Gana la coincidencia MÁS LARGA y, a igual largo, la que tiene más negocios: "León" es
 * un municipio de Guanajuato y también una colonia en otras tres entidades.
 */
export async function resolveCriteria(criteria: string): Promise<
  | { ok: true; what: string; place: { nombre: string; tipo: string; entidad: string | null; lat: number; lon: number }; radius: number }
  | { ok: false; error: string }
> {
  const { buscarZona } = await import("../directorio.server");
  const clean = stripAccents(criteria).replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  if (!clean) return { ok: false, error: "Escribe qué negocios buscas y dónde" };

  const place = await buscarZona(clean);
  if (!place) {
    return {
      ok: false,
      error: "No reconocí el lugar. Escribe la ciudad, el municipio o la colonia — por ejemplo «dentistas en Torreón».",
    };
  }

  // El QUÉ es lo que queda al quitar el lugar y las palabras de relleno.
  const sinLugar = clean.replace(new RegExp(`\\b${stripAccents(place.nombre).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), " ");
  const what = sinLugar.replace(STOPWORDS, " ").replace(/\b\d+\b/g, " ").replace(/\s+/g, " ").trim();

  return { ok: true, what, place, radius: RADIUS[place.tipo] ?? 12_000 };
}

export const directorio: SearchSource = {
  id: "directorio",
  label: "Directorio de negocios de México",
  blurb:
    "Directorio propio con ~5.5 millones de negocios de todo México. Da nombre, giro, " +
    "sector, teléfono, correo, sitio, dirección, ubicación en el mapa, tamaño y antigüedad. " +
    "Se busca por qué y dónde: «dentistas en Torreón», «ferreterías en Polanco».",

  columns: [
    { key: "sector", label: "Sector" },
    { key: "tamano", label: "Tamaño" },
    { key: "antiguedad", label: "Años en el directorio" },
    // ⚠️ Estas dos etiquetas son load-bearing: `findLatLon` (Grid.tsx) las reconoce POR
    // NOMBRE y colapsa el par en un enlace al local en vez de dos columnas de flotantes.
    { key: "lat", label: "Latitud" },
    { key: "lon", label: "Longitud" },
  ],

  async search(criteria, limit): Promise<Found[]> {
    const r = await resolveCriteria(criteria);
    if (!r.ok) throw new Error(r.error);
    return buscarDirectorio({
      what: r.what,
      lat: r.place.lat,
      lng: r.place.lon,
      radius: r.radius,
      limit,
    });
  },
};

/** Cuántos hay antes de crear la lista. Deja decir «hay 3,412» en vez de traer 100 a ciegas. */
export async function contarCriterio(criteria: string): Promise<{ ok: true; total: number; lugar: string } | { ok: false; error: string }> {
  const r = await resolveCriteria(criteria);
  if (!r.ok) return r;
  const total = await contarDirectorio({ what: r.what, lat: r.place.lat, lng: r.place.lon, radius: r.radius });
  return { ok: true, total, lugar: r.place.entidad && r.place.entidad !== r.place.nombre ? `${r.place.nombre}, ${r.place.entidad}` : r.place.nombre };
}
