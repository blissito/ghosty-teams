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
 * Techo entre guardados. Bajó de 60s a 8s cuando los guardados humanos CONSECUTIVOS
 * pasaron a escribirse encima de la misma versión (`updateDocBlocksFn`): ya no insertan
 * fila, así que dejaron de comerse las 20 versiones que guarda el documento. Con 60s la
 * persona podía estar escribiendo un minuto entero sin ver una sola señal de guardado.
 */
const SAVE_MIN_INTERVAL_MS = 8_000;

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
  version,
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
  /** La versión que enseña el panel (`?v`). Sin ella se lee la viva, que es lo que se ve. */
  version?: string | number | null;
  /**
   * El estado del guardado, hacia arriba, para que el panel lo pinte EN SU BARRA.
   *
   * Es donde lo pone todo el mundo (Google Docs y Word lo ponen junto al título) y donde
   * la gente lo busca. El indicador flotante de abajo a la izquierda seguía existiendo y
   * nadie lo veía: escribir en un documento sin recibir señal deja la duda de si se
   * guardó, y "se guarda solo" hay que demostrarlo.
   */
  onGuardado?: (estado: "pendiente" | "guardando" | "ok" | "error" | null) => void;
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

  // Estado del guardado, para que se VEA. Escribir en un documento y no recibir ninguna
  // señal deja la duda de si se guardó — y la respuesta "se guarda solo" hay que
  // demostrarla, no prometerla.
  const [guardado, setGuardado] = useState<"pendiente" | "guardando" | "ok" | "error" | null>(null);

  // Devuelve la promesa del guardado: el "leer en voz alta" la espera. El audio lo
  // sintetiza el SERVIDOR desde el documento guardado, así que darle a la bocina con una
  // edición aún en el debounce leía en voz alta el texto anterior — el usuario cambiaba
  // una frase, la escuchaba, y oía la vieja.
  const flush = useCallback((): Promise<void> => {
    const blocks = pending.current;
    if (!blocks || !documentId) return Promise.resolve();
    pending.current = null;
    lastSaved.current = Date.now();
    setGuardado("guardando");
    return updateDocBlocksFn({ data: { documentId, blocks, messageId, title } })
      .then(() => {
        setGuardado("ok");
        // Se va solo: un "Guardado" permanente deja de comunicar a los diez segundos.
        setTimeout(() => setGuardado((s) => (s === "ok" ? null : s)), 2600);
      })
      .catch((e) => {
        console.error("[doc] no se pudo guardar", e);
        // El error NO se desvanece: perder texto en silencio es lo peor que puede pasar.
        setGuardado("error");
      });
  }, [documentId, messageId, title]);

  const onChange = useCallback(
    (blocks: DocBlock[]) => {
      if (!documentId) return;
      pending.current = blocks;
      // Señal INMEDIATA: el cambio ya está registrado aunque el guardado espere al
      // debounce. Sin esto la persona escribe y no pasa nada visible durante segundos.
      setGuardado((g) => (g === "guardando" ? g : "pendiente"));
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
        guardado={guardado}
        // Antes de leer en voz alta hay que guardar: si no, se escucha el texto anterior.
        guardarYa={flush}
        // Para el "leer en voz alta": el audio lo sintetiza el servidor desde ESTE
        // documento y ESTA versión, no desde el texto que tenga el cliente.
        documentId={documentId}
        version={version}
      />
    </Suspense>
  );
}
