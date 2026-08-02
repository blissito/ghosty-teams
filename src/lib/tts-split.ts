// ── Partir un bloque en frases, para que la voz arranque ya ──────────────────
//
// `kokoro-svc` sintetiza a ~16 ms por carácter, lineal y sin nada que se pueda
// paralelizar (medido: satura sus 4 vcpus con una sola petición, y dos peticiones a la
// vez tardan exactamente el doble). O sea que el tiempo hasta el primer sonido es una
// función directa de CUÁNTO TEXTO se pide de golpe: un párrafo de 390 caracteres son 6.4
// segundos mirando un botón, y su primera frase son 1.6.
//
// Lo que salva la jugada es que la síntesis va 4× más rápida que la reproducción (RTF
// ≈ 0.25): en cuanto suena la primera frase hay holgura de sobra para tener lista la
// siguiente. Por eso la unidad de la PETICIÓN es la frase, aunque la unidad del
// RESALTADO siga siendo el bloque.
//
// Este módulo es la única definición del corte y lo importan los dos lados: el cliente
// para adivinar qué pedir a continuación, el servidor para decidir qué texto sintetiza
// un `?s=<n>`. Si los dos no cortan igual, el cliente pide una frase y escucha otra.
//
// ⚠️ **Nada de `Intl.Segmenter`**: su comportamiento depende de la versión de ICU, que
// no es la misma en Node que en el navegador del usuario. Un splitter que corta distinto
// en cada lado rompe exactamente la garantía que este archivo existe para dar.

/** Por debajo de esto, un segmento no vale su propia petición (~0.3 s de overhead). */
export const MIN_CHARS = 120;
/** El primero SÍ puede ser corto: es lo único que separa al usuario del primer sonido. */
export const MIN_PRIMERA = 45;
/** Techo por segmento: ~5 s de audio, ~5 s de síntesis. Más, y saltar de frase se siente. */
export const MAX_CHARS = 320;

// Abreviaturas es-MX cuyo punto NO termina la frase. Se comparan en minúsculas contra el
// final del segmento acumulado.
const ABREVIATURAS = [
  "sr", "sra", "srta", "dr", "dra", "lic", "ing", "arq", "mtro", "mtra", "prof",
  "art", "arts", "av", "no", "núm", "num", "pág", "pag", "frac", "inc", "fracc",
  "etc", "ej", "vs", "aprox", "depto", "col", "c.p", "ee.uu", "ss", "pp", "cía",
];

/** ¿El punto que cierra `acum` es de verdad un fin de frase? */
function cortaDeVerdad(acum: string, resto: string): boolean {
  // Iniciales y abreviaturas: "J. Pérez", "Sr. López", "art. 14".
  const ultima = acum.match(/([\p{L}\p{N}.]+)[.!?…]+["'”’)\]]*$/u)?.[1] ?? "";
  const sinPunto = ultima.replace(/\.+$/, "").toLowerCase();
  if (sinPunto.length === 1 && /\p{L}/u.test(sinPunto)) return false;
  if (ABREVIATURAS.includes(sinPunto)) return false;
  // Decimales y numeraciones: "3.5", "1.2.3", y la viñeta "1. Objeto" al inicio.
  if (/\d$/.test(sinPunto) && /^\s*\d/.test(resto)) return false;
  if (/^\d+$/.test(sinPunto) && acum.trim() === ultima) return false;
  return true;
}

/** Corte inicial por puntuación fuerte, sin mirar longitudes todavía. */
function porPuntuacion(texto: string): string[] {
  const out: string[] = [];
  let acum = "";
  for (let i = 0; i < texto.length; i++) {
    acum += texto[i];
    if (!/[.!?…]/.test(texto[i])) continue;
    // Traga los signos y comillas de cierre pegados.
    while (i + 1 < texto.length && /[.!?…"'”’)\]]/.test(texto[i + 1])) acum += texto[++i];
    const resto = texto.slice(i + 1);
    // El corte sólo existe si sigue un espacio (o el final): "www.gob.mx" no es tres frases.
    if (resto && !/^\s/.test(resto)) continue;
    if (!cortaDeVerdad(acum, resto.trimStart())) continue;
    out.push(acum.trim());
    acum = "";
    while (i + 1 < texto.length && /\s/.test(texto[i + 1])) i++;
  }
  if (acum.trim()) out.push(acum.trim());
  return out;
}

/** Parte un segmento que se pasa de `MAX_CHARS`, por el sitio menos malo que encuentre. */
function partirLargo(s: string): string[] {
  if (s.length <= MAX_CHARS) return [s];
  // Por este orden: puntuación media, coma, y como último recurso un espacio.
  for (const re of [/[;:]\s/g, /,\s/g, /\s/g]) {
    let mejor = -1;
    const objetivo = s.length / 2;
    for (const m of s.matchAll(re)) {
      const corte = m.index + m[0].length;
      if (corte <= 1 || corte >= s.length) continue;
      if (mejor === -1 || Math.abs(corte - objetivo) < Math.abs(mejor - objetivo)) mejor = corte;
    }
    if (mejor > 0) {
      return [...partirLargo(s.slice(0, mejor).trim()), ...partirLargo(s.slice(mejor).trim())];
    }
  }
  // Una sola palabra kilométrica: se manda entera, es mejor que cortarla a la mitad.
  return [s];
}

/**
 * Los trozos que se sintetizan de un bloque, en orden.
 *
 * La entrada es SIEMPRE `blockText(b).trim()` — ya viene con los espacios normalizados,
 * que es lo que hace que cliente y servidor produzcan la misma lista.
 *
 * Garantías (y hay test de cada una): con texto no vacío devuelve al menos un elemento,
 * y `partirEnFrases(t).join(" ") === t`. Nunca se fusiona texto de dos bloques: el
 * resaltado va por bloque y un audio a caballo de dos rompería la marca.
 */
export function partirEnFrases(texto: string): string[] {
  const limpio = texto.trim();
  if (!limpio) return [];

  const crudos = porPuntuacion(limpio);
  if (!crudos.length) return [limpio];

  // Fusión de los cortos: un "Sí." solo cuesta una petición entera para 0.3 s de audio.
  const juntos: string[] = [];
  for (const trozo of crudos) {
    const minimo = juntos.length === 0 ? MIN_PRIMERA : MIN_CHARS;
    const anterior = juntos[juntos.length - 1];
    if (anterior !== undefined && anterior.length < minimo && anterior.length + trozo.length <= MAX_CHARS) {
      juntos[juntos.length - 1] = `${anterior} ${trozo}`;
    } else {
      juntos.push(trozo);
    }
  }
  // Si el ÚLTIMO quedó corto se pega al anterior: no hay "siguiente" al que engancharlo.
  if (juntos.length > 1) {
    const ultimo = juntos[juntos.length - 1];
    const penultimo = juntos[juntos.length - 2];
    if (ultimo.length < MIN_CHARS && ultimo.length + penultimo.length <= MAX_CHARS) {
      juntos.splice(juntos.length - 2, 2, `${penultimo} ${ultimo}`);
    }
  }

  return juntos.flatMap(partirLargo);
}

/** Cuántos segmentos tiene un bloque. Azúcar para el cliente, que sólo necesita el número. */
export function cuentaFrases(texto: string): number {
  return partirEnFrases(texto).length;
}
