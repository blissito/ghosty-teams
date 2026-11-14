/**
 * Giros que se buscan por CLASE SCIAN y no por palabras.
 *
 * Por qué (14-nov-2026): «agencias de publicidad en CDMX» buscaba las palabras en el nombre
 * y la actividad, y traía imprentas, estampados y suajes que se llaman «Publicidad X». Peor:
 * las agencias digitales de verdad casi nunca dicen «publicidad» — en el directorio viven en
 * 541510 («diseño de sistemas de cómputo»), 788 en CDMX y 478 con sitio web.
 *
 * Las claves están medidas contra el directorio (CDMX, 14-nov), no copiadas de memoria.
 * Se comparan por PREFIJO. El texto llega ya sin acentos ni palabras de relleno.
 */
export type Giro = { label: string; scian: string[] };

const GIROS: { re: RegExp; giro: Giro }[] = [
  {
    re: /\b(agencias? (de )?(marketing|mercadotecnia) digital|agencias? digital(es)?|marketing digital|mercadotecnia digital)\b/,
    giro: { label: "agencias digitales", scian: ["541510", "541810"] },
  },
  {
    re: /\b(desarroll\w* (web|software|apps?|aplicaciones|paginas|sitios)|paginas web|sitios web|desarrolladores?|programadores?|software)\b/,
    giro: { label: "desarrollo web y software", scian: ["541510"] },
  },
  {
    re: /\b(agencias? (de )?(publicidad|anuncios)|publicistas?)\b/,
    giro: { label: "agencias de publicidad", scian: ["541810", "541850"] },
  },
  { re: /\b(diseno grafico|disenadores? graficos?)\b/, giro: { label: "diseño gráfico", scian: ["541430"] } },
  { re: /\b(relaciones publicas)\b/, giro: { label: "relaciones públicas", scian: ["541820"] } },
];

export function giroScian(what: string): Giro | null {
  const t = what.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return GIROS.find((g) => g.re.test(t))?.giro ?? null;
}

/**
 * «500 agencias de publicidad en…» → 500. Sólo un número AL INICIO: en medio puede ser una
 * calle («contadores en 5 de Mayo»). Tope de 500, igual que `createListFn`.
 */
export function cuantosPide(criteria: string): number | null {
  const n = Number(criteria.trim().match(/^(\d{1,4})\b/)?.[1]);
  return n > 0 ? Math.min(n, 500) : null;
}
