import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import DocSurface from "../components/DocSurface";
import { serializeDocEnvelope, type DocBlock } from "../lib/doc-blocks";

// Banco de pruebas del editor de documentos. Existe porque depurar el marcado del cambio
// quirúrgico en producción salía carísimo: cada intento era un deploy con ~90s de servicio
// caído y una prueba manual del usuario. Aquí el documento y el patch son sintéticos, así
// que el ciclo es instantáneo y no toca a nadie.
const bloques: DocBlock[] = Array.from({ length: 102 }, (_, i) => ({
  id: `b-${i}`,
  type: i === 0 ? "heading" : "paragraph",
  props: i === 0 ? { level: 1 } : {},
  content: [{ type: "text", text: i === 0 ? "DENUNCIA Y/O QUERELLA" : `Bloque ${i} — párrafo de relleno para dar altura al documento.`, styles: {} }],
}));

export const Route = createFileRoute("/doc-probe")({ component: Probe, ssr: false });

function Probe() {
  // Doble cerrojo: además de la exención de sesión (que ya es sólo en dev), la página no
  // se pinta en producción. Un banco de pruebas no tiene por qué existir ahí.
  if (!import.meta.env.DEV) return null;
  return <ProbeReal />;
}

function ProbeReal() {
  const [refs, setRefs] = useState<string[] | undefined>();
  const md = serializeDocEnvelope({ blocks: bloques, sourceMd: "# x" });
  return (
    <div className="flex h-screen flex-col bg-surface">
      <div className="flex items-center gap-3 border-b border-border p-3">
        <button
          type="button"
          onClick={() => setRefs(["n3", "n76"])}
          className="rounded bg-brand px-3 py-1.5 text-sm text-brand-fg"
        >
          Marcar n3 y n76
        </button>
        <button type="button" onClick={() => setRefs(undefined)} className="rounded border border-border px-3 py-1.5 text-sm">
          limpiar
        </button>
        <span className="text-xs text-muted">refs: {JSON.stringify(refs)}</span>
      </div>
      {/* Réplica del contenedor REAL del panel: un BLOQUE con overflow-auto que NO es
          flex container. Mi prueba anterior usaba un flex y por eso no reproducía el bug
          del botón: en un flex el hijo sí queda acotado. Aquí no, como en la app. */}
      <div className="relative block min-h-0 flex-1 overflow-auto">
        <DocSurface md={md} documentId="doc_probe" messageId={1} title="Probe" patchRefs={refs} />
      </div>
    </div>
  );
}
