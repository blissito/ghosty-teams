// ── Ortografía y gramática: texto → hallazgos, por `languagetool-svc` vía Studio ──
//
// No se llama a la caja directo: es de la flota y el mesh enruta por el dueño del
// llamador, así que desde la caja de Teams contesta 503. Studio la resuelve y hace de
// puente con el MISMO contrato HMAC que ya usan el PDF, la miniatura y la voz.
//
// **Por qué reglas y no un modelo.** Medido por terceros y consistente: GPT-3.5/4 tienen
// mejor recall pero PEOR precisión que Word y Google Docs — sobre-corrigen y cambian el
// sentido. LanguageTool descartó los LLMs por coste, velocidad y precisión, y lo resume
// bien: en producción los falsos positivos cansan muy rápido. Aquí las reglas ponen lo
// objetivo (tildes, concordancia, puntuación) y el agente queda para lo de criterio, en
// una acción aparte que se pide a propósito.
//
// ⚠️ **El caché se llavea por el CONTENIDO, no por el id del bloque** — misma decisión
// que en la voz, y por lo mismo: cambias el párrafo, cambia el hash, y los hallazgos
// viejos dejan de pedirse sin una sola línea de invalidación.
import { createHash } from "node:crypto";

/** Un hallazgo, ya recortado a lo que la interfaz necesita. */
export type Hallazgo = {
  /** Inicio dentro del texto que se mandó (el `blockText` del bloque). */
  offset: number;
  length: number;
  mensaje: string;
  /** Sugerencias, en el orden que da LanguageTool (el primero es el bueno). */
  sugerencias: string[];
  /** `misspelling` | `grammar` | `style` | `typographical`… tal cual lo da la regla. */
  tipo: string;
  ruleId: string;
};

// Caché en memoria del proceso. Un documento se revisa varias veces (abres, corriges un
// párrafo, vuelves a revisar) y los bloques que no tocaste no tienen por qué volver a
// viajar. No va a disco a propósito: los hallazgos son efímeros y una revisión completa
// de un documento normal cuesta un par de segundos.
const MAX_ENTRADAS = 2000;
const cache = new Map<string, Hallazgo[]>();

function recordar(k: string, v: Hallazgo[]) {
  cache.set(k, v);
  // Map itera en orden de inserción: la primera llave es la más vieja.
  while (cache.size > MAX_ENTRADAS) {
    const vieja = cache.keys().next().value;
    if (vieja === undefined) break;
    cache.delete(vieja);
  }
}

/** La llave del caché: idioma + hash del texto. Ver la nota de arriba. */
export function claveRevision(texto: string, idioma: string): string {
  return `${idioma}:${createHash("sha256").update(texto).digest("hex").slice(0, 32)}`;
}

/**
 * Reglas que sólo tienen sentido en un PÁRRAFO.
 *
 * Un título no lleva punto final y un elemento de lista no empieza en mayúscula: marcarlos
 * sería ruido en cada documento, y el ruido es justo lo que hace que la gente apague el
 * corrector.
 */
const SOLO_PARRAFO = new Set(["PUNCTUATION_PARAGRAPH_END", "UPPERCASE_SENTENCE_START"]);

/**
 * Revisa UN trozo de texto. Devuelve `null` ante cualquier fallo — la ruta lo traduce y la
 * interfaz avisa; no hay motor de respaldo porque un segundo corrector daría otros
 * resultados y "a veces me marca cosas distintas" es peor que "ahora no se pudo".
 *
 * `esParrafo` filtra las reglas de arriba.
 */
export async function revisar(
  texto: string,
  { idioma = "es", esParrafo = true }: { idioma?: string; esParrafo?: boolean } = {},
): Promise<Hallazgo[] | null> {
  const limpio = texto.trim();
  if (!limpio) return [];

  const k = claveRevision(limpio, idioma);
  const hit = cache.get(k);
  if (hit) {
    // Refresca su posición en el LRU: lo que se está revisando ahora es lo que conviene
    // conservar.
    cache.delete(k);
    cache.set(k, hit);
    return esParrafo ? hit : hit.filter((h) => !SOLO_PARRAFO.has(h.ruleId));
  }

  try {
    const { nativeRuntimeBase, partnerHeaders } = await import("./ghosty-runtime.server");
    const base = await nativeRuntimeBase();
    if (!base) {
      console.error("[lt] sin runtime nativo: no hay a quién pedirle la revisión");
      return null;
    }
    const { currentNamespace } = await import("./tenant.server");
    const body = JSON.stringify({ text: limpio, language: idioma });
    const res = await fetch(`${base}/api/v2/check`, {
      method: "POST",
      headers: partnerHeaders(body, await currentNamespace()),
      body,
      // Más que el timeout de Studio (45s) para no cortar antes que él y perder su mensaje.
      signal: AbortSignal.timeout(55_000),
    });
    if (!res.ok) {
      console.error(`[lt] studio devolvió ${res.status}`);
      return null;
    }
    const data = (await res.json()) as {
      matches?: {
        offset: number;
        length: number;
        message: string;
        replacements?: { value: string }[];
        rule?: { id?: string; issueType?: string };
      }[];
    };
    const todos: Hallazgo[] = (data.matches ?? []).map((m) => ({
      offset: m.offset,
      length: m.length,
      mensaje: m.message,
      // Tres sugerencias bastan: una lista larga en una tarjeta pequeña no se lee, y a
      // partir de la tercera LanguageTool ya está adivinando.
      sugerencias: (m.replacements ?? []).slice(0, 3).map((r) => r.value),
      tipo: m.rule?.issueType || "other",
      ruleId: m.rule?.id || "",
    }));
    recordar(k, todos);
    return esParrafo ? todos : todos.filter((h) => !SOLO_PARRAFO.has(h.ruleId));
  } catch (e) {
    console.error("[lt] falló:", e instanceof Error ? e.message : e);
    return null;
  }
}
