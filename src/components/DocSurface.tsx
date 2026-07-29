import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { parseDocEnvelope, type DocBlock } from "../lib/doc-blocks";
import { updateDocBlocksFn } from "../server/artifacts";

// Frontera entre el panel y el editor. Hace cuatro cosas y ninguna más:
//
//  1. LAZY: BlockNote + Mantine son pesados. Se descargan al abrir un documento, no
//     al cargar el room.
//  2. Decide qué es la verdad: sobre `v:1` (bloques) o markdown (streaming y filas
//     legacy anteriores al sobre).
//  3. Amortigua el stream: el body del turno se re-emite completo en cada tick, y
//     re-parsear markdown en cada uno es trabajo tirado.
//  4. Guarda la edición humana con una cadencia que no se coma las versiones.
//
// El montaje es el MISMO para el borrador en vivo y para el documento publicado, con
// el mismo `key` en las dos ramas de ArtifactPanel: así el swap borrador→doc no
// remonta el editor, sólo cambia este prop. Es el equivalente del `ArtifactCalque`
// del artefacto HTML, y sale gratis porque aquí no hay iframe que reiniciar.

const DocEditor = lazy(() => import("./DocEditor"));

/** Coalescencia del stream. Suficiente para que se vea fluido sin re-parsear de más. */
const STREAM_COALESCE_MS = 120;
/** Se guarda cuando dejas de escribir. */
const SAVE_IDLE_MS = 2500;
/**
 * Y como MUCHO una versión por minuto. Cada guardado es un INSERT y
 * `pruneArtifactVersions` conserva 20 versiones por documento: sin este techo, un minuto
 * de tecleo se comería todas las versiones del agente.
 */
const SAVE_MIN_INTERVAL_MS = 60_000;

function Sheet({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-surface-3 p-4 sm:p-6">
      <div className="mx-auto max-w-[8.5in]">
        <article className="grid min-h-[60vh] place-items-center rounded-sm bg-white text-black shadow-md">
          {children}
        </article>
      </div>
    </div>
  );
}

export default function DocSurface({
  md,
  streaming = false,
  documentId,
  messageId,
  title,
  patchRefs,
}: {
  /** Crudo de `gc_artifacts.md` o del fence: sobre JSON o markdown. */
  md: string;
  streaming?: boolean;
  /** Sin `documentId` el documento es de sólo lectura (es el caso del borrador). */
  documentId?: string;
  messageId?: number;
  title?: string;
  /** Alias del patch en curso → el editor marca ya, sin esperar la republicación. */
  patchRefs?: string[];
}) {
  // El sobre se parsea en cada render, pero es sólo un JSON.parse del string que ya
  // tenemos, y `md` cambia poco cuando NO se está streameando.
  const envelope = useMemo(() => parseDocEnvelope(md), [md]);

  // Markdown amortiguado: sólo se usa cuando no hay sobre. Durante el stream llegan
  // muchos ticks por segundo y cada uno costaría un parseo a bloques.
  const [slowMd, setSlowMd] = useState(() => (envelope ? "" : md));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (envelope) return;
    if (!streaming) {
      // Fuera del stream el valor entra directo: esperar 120 ms para pintar un
      // documento ya cerrado sólo se vería como un tirón.
      setSlowMd(md);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setSlowMd(md), STREAM_COALESCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [md, streaming, envelope]);

  // ── Guardado de la edición humana ───────────────────────────────────────────
  const pending = useRef<DocBlock[] | null>(null);
  const lastSaved = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    const blocks = pending.current;
    if (!blocks || !documentId) return;
    pending.current = null;
    lastSaved.current = Date.now();
    updateDocBlocksFn({ data: { documentId, blocks, messageId, title } }).catch((e) =>
      console.error("[doc] no se pudo guardar", e),
    );
  }, [documentId, messageId, title]);

  const onChange = useCallback(
    (blocks: DocBlock[]) => {
      if (!documentId) return;
      pending.current = blocks;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      // Espera a que pares de escribir, pero nunca antes de que se cumpla el minuto
      // desde el último guardado.
      const since = Date.now() - lastSaved.current;
      saveTimer.current = setTimeout(flush, Math.max(SAVE_IDLE_MS, SAVE_MIN_INTERVAL_MS - since));
    },
    [documentId, flush],
  );

  // Cerrar el panel, cambiar de pestaña o recargar NO puede perder lo escrito: ahí se
  // guarda ya, sin esperar el debounce.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      flush();
    };
  }, [flush]);

  // Bloques que cambiaron en esta versión. El "ya lo señalé" NO se decide aquí: se
  // decide dentro del efecto que pinta, en DocEditor.
  //
  // Aquí estaba el bug que hacía que el resaltado no saliera NUNCA. El guard vivía en un
  // `useMemo`, o sea un efecto secundario durante el render — y DocEditor se carga LAZY,
  // así que el primer render SUSPENDE y React lo descarta. Al re-montar, el memo
  // recalculaba, encontraba la clave ya marcada y devolvía undefined: el guard se comía
  // su propio resaltado. Los renders se pueden descartar y repetir; sólo los efectos
  // corren una vez.
  const marcar = envelope?.changedIds?.length && documentId ? envelope.changedIds : undefined;

  const source = envelope ? { blocks: envelope.blocks } : { markdown: slowMd };
  const vacio = envelope ? !envelope.blocks.length : !slowMd.trim();

  // Un documento vacío no monta el editor: BlockNote pintaría su párrafo vacío y se
  // leería como un documento en blanco en vez de "todavía no hay nada".
  if (vacio && !streaming) {
    return <Sheet><span className="text-sm text-neutral-400">Sin contenido</span></Sheet>;
  }

  return (
    <Suspense
      fallback={
        <Sheet>
          <Loader2 size={20} className="animate-spin text-neutral-300" />
        </Sheet>
      }
    >
      <DocEditor
        {...source}
        // Editable en cuanto el agente suelta el turno. Un borrador (sin documentId)
        // todavía no existe como fila, así que no hay dónde guardar.
        editable={!!documentId && !streaming}
        streaming={streaming}
        onChange={onChange}
        highlightIds={marcar}
        patchRefs={patchRefs}
      />
    </Suspense>
  );
}
