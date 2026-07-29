import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { parseDocEnvelope, type DocBlock } from "../lib/doc-blocks";

// Frontera entre el panel y el editor. Hace tres cosas y ninguna más:
//
//  1. LAZY: BlockNote + Mantine son pesados. Se descargan al abrir un documento, no
//     al cargar el room.
//  2. Decide qué es la verdad: sobre `v:1` (bloques) o markdown (streaming y filas
//     legacy anteriores al sobre).
//  3. Amortigua el stream: el body del turno se re-emite completo en cada tick, y
//     re-parsear markdown en cada uno es trabajo tirado.
//
// El montaje es el MISMO para el borrador en vivo y para el documento publicado, con
// el mismo `key` en las dos ramas de ArtifactPanel: así el swap borrador→doc no
// remonta el editor, sólo cambia este prop. Es el equivalente del `ArtifactCalque`
// del artefacto HTML, y sale gratis porque aquí no hay iframe que reiniciar.

const DocEditor = lazy(() => import("./DocEditor"));

/** Coalescencia del stream. Suficiente para que se vea fluido sin re-parsear de más. */
const STREAM_COALESCE_MS = 120;

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
  editable = false,
  onChange,
}: {
  /** Crudo de `gc_artifacts.md` o del fence: sobre JSON o markdown. */
  md: string;
  streaming?: boolean;
  editable?: boolean;
  onChange?: (blocks: DocBlock[]) => void;
}) {
  // El sobre se parsea en cada render pero es sólo un JSON.parse del string que ya
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
      <DocEditor {...source} editable={editable} streaming={streaming} onChange={onChange} />
    </Suspense>
  );
}
