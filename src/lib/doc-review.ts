// ── Revisión ortográfica y gramatical del documento ──────────────────────────
//
// El modelo NO es "corregir mientras escribes". Es una PASADA DE REVISIÓN, como un code
// review del documento: revisas cuando quieres, recorres los hallazgos uno a uno y aplicas
// los que valgan.
//
// Esa decisión sale de mirar qué odia la gente de los correctores: el subrayado permanente
// interrumpe, y las sugerencias agresivas acaban cambiando lo que querías decir. Por eso
// aquí el documento se lee LIMPIO —sólo un contador discreto dice cuántas hay— y nada se
// pinta hasta que entras en revisión.
//
// Hermano de `read-aloud.ts` y con su misma forma: el hook no sabe pintar ni scrollear,
// sólo mantiene la lista y avisa "ahora toca este hallazgo".
import { useCallback, useRef, useState } from "react";
import { blockText, type DocBlock } from "./doc-blocks";
import { firmaTexto } from "./doc-firma";

export type EstadoRevision = "parado" | "revisando" | "listo";

export type Hallazgo = {
  /** `bloque:offset:regla` — estable mientras el bloque no cambie. */
  id: string;
  blockId: string;
  /** Firma del texto del bloque CUANDO se encontró. Si deja de coincidir, caducó. */
  hash: string;
  offset: number;
  length: number;
  /** El texto señalado, para comprobar antes de aplicar que sigue siendo lo que era. */
  palabra: string;
  mensaje: string;
  sugerencias: string[];
  tipo: string;
  ruleId: string;
};

type Opts = {
  documentId?: string;
  version?: string | number | null;
  /** Los bloques del editor, en su árbol completo. */
  bloques: () => DocBlock[];
};

/** Aplana el árbol a `{id → texto}`: los hallazgos se direccionan por id, nunca por índice. */
function textos(blocks: DocBlock[], out = new Map<string, string>()): Map<string, string> {
  for (const b of blocks) {
    if (b.id) out.set(b.id, blockText(b));
    if (b.children?.length) textos(b.children, out);
  }
  return out;
}

/**
 * Las que se pueden aplicar en bloque sin pensar: faltas de ortografía con una sugerencia
 * clara. Lo de estilo y lo dudoso NO entra — ahí es donde un corrector cambia el sentido
 * de una frase y el autor se entera tarde.
 */
export function esSegura(h: Hallazgo): boolean {
  return h.tipo === "misspelling" && h.sugerencias.length > 0;
}

export function useDocReview({ documentId, version, bloques }: Opts) {
  const [hallazgos, setHallazgos] = useState<Hallazgo[]>([]);
  const [actual, setActual] = useState(0);
  const [estado, setEstado] = useState<EstadoRevision>("parado");
  const [error, setError] = useState<string | null>(null);
  /** Cierto cuando el usuario ENTRÓ en revisión: hasta entonces no se pinta nada. */
  const [revisando, setRevisando] = useState(false);
  const gen = useRef(0);

  /**
   * Lanza la revisión. `silenciosa` la deja en segundo plano: cuenta hallazgos pero no
   * enciende el modo revisión — es la "insinuación" al abrir el documento.
   */
  const revisar = useCallback(
    async (silenciosa = false) => {
      if (!documentId) return;
      const mi = ++gen.current;
      setError(null);
      setEstado("revisando");
      if (!silenciosa) setRevisando(true);

      const q = new URLSearchParams();
      if (version != null && version !== "") q.set("v", String(version));
      const encontrados: Hallazgo[] = [];
      try {
        const r = await fetch(`/api/doc-check/${documentId}?${q}`);
        if (!r.ok || !r.body) throw new Error(`check ${r.status}`);
        const lector = r.body.getReader();
        const dec = new TextDecoder();
        let resto = "";
        const mapa = textos(bloques());
        for (;;) {
          const { done, value } = await lector.read();
          if (done || gen.current !== mi) break;
          resto += dec.decode(value, { stream: true });
          const lineas = resto.split("\n");
          resto = lineas.pop() ?? "";
          for (const l of lineas) {
            if (!l.trim()) continue;
            let fila: {
              id?: string;
              hash?: string;
              error?: boolean;
              matches?: { offset: number; length: number; mensaje: string; sugerencias: string[]; tipo: string; ruleId: string }[];
            };
            try {
              fila = JSON.parse(l);
            } catch {
              continue;
            }
            if (fila.error) {
              // Un bloque que el servicio no pudo revisar se DICE. Dar por bueno un
              // documento que nadie revisó es peor que avisar de que faltó un trozo.
              setError("La revisión quedó incompleta");
              continue;
            }
            if (!fila.id || !fila.matches?.length) continue;
            const texto = mapa.get(fila.id) ?? "";
            for (const m of fila.matches) {
              encontrados.push({
                id: `${fila.id}:${m.offset}:${m.ruleId}`,
                blockId: fila.id,
                hash: fila.hash ?? firmaTexto(texto),
                offset: m.offset,
                length: m.length,
                palabra: texto.slice(m.offset, m.offset + m.length),
                mensaje: m.mensaje,
                sugerencias: m.sugerencias,
                tipo: m.tipo,
                ruleId: m.ruleId,
              });
            }
            // Se publica en cada línea: la revisión se ve avanzar en vez de aparecer de
            // golpe al final.
            if (gen.current === mi) setHallazgos([...encontrados]);
          }
        }
      } catch (e) {
        console.error("[revision]", e);
        if (gen.current === mi) setError("No se pudo revisar el documento");
      }
      if (gen.current !== mi) return;
      setActual(0);
      setEstado("listo");
    },
    [documentId, version, bloques],
  );

  /**
   * Quita los hallazgos de los bloques que ya no son los que eran.
   *
   * Invalidación por CONTENIDO: sin lógica de invalidación que mantener, y sin el riesgo
   * de señalar una falta en un texto que el usuario ya arregló a mano.
   */
  const caducar = useCallback(() => {
    const mapa = textos(bloques());
    setHallazgos((prev) => {
      const vivos = prev.filter((h) => {
        const t = mapa.get(h.blockId);
        return t !== undefined && firmaTexto(t) === h.hash;
      });
      return vivos.length === prev.length ? prev : vivos;
    });
  }, [bloques]);

  /**
   * Saca un hallazgo de la lista y recoloca los que quedan en su mismo bloque.
   *
   * Al aplicar una corrección cambia el texto del bloque, así que sus vecinos caducarían
   * por su propia firma. Se les desplaza el offset por la diferencia de longitud y se les
   * refresca el hash: si no, corregir la primera falta de un párrafo se llevaría por
   * delante todas las demás de ese párrafo.
   */
  const resolver = useCallback(
    (h: Hallazgo, delta: number) => {
      setHallazgos((prev) => {
        const mapa = textos(bloques());
        const nuevoHash = firmaTexto(mapa.get(h.blockId) ?? "");
        return prev
          .filter((x) => x.id !== h.id)
          .map((x) => {
            if (x.blockId !== h.blockId) return x;
            const off = x.offset > h.offset ? x.offset + delta : x.offset;
            return { ...x, offset: off, hash: nuevoHash, id: `${x.blockId}:${off}:${x.ruleId}` };
          });
      });
      setActual((i) => Math.max(0, Math.min(i, hallazgos.length - 2)));
    },
    [bloques, hallazgos.length],
  );

  const ir = useCallback(
    (delta: number) => {
      setActual((i) => Math.min(Math.max(i + delta, 0), Math.max(0, hallazgos.length - 1)));
    },
    [hallazgos.length],
  );

  const salir = useCallback(() => {
    gen.current++;
    setRevisando(false);
    setEstado("parado");
  }, []);

  return {
    hallazgos,
    actual: hallazgos[actual] ?? null,
    indice: actual,
    total: hallazgos.length,
    estado,
    error,
    revisando,
    entrar: () => setRevisando(true),
    salir,
    revisar,
    caducar,
    resolver,
    ir,
    setActual,
  };
}
