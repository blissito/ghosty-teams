import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { docCollabConnFn, persistDocSectionFn, type CollabConn } from "../server/collab";

// Outer del editor colaborativo nativo: resuelve la conexión (server fn, server-to-server
// a EasyBits) y LAZY-carga el editor BlockNote pesado sólo al abrir un doc. Espejo del
// CollabDocumentEditor de EasyBits, pero nativo de GTeams (no iframe).
const CollabEditor = lazy(() => import("./CollabEditor"));

function Spinner({ label }: { label: string }) {
  return (
    <div className="grid h-full place-items-center bg-[#f3f3f5]">
      <div className="flex flex-col items-center gap-3 text-neutral-400">
        <Loader2 size={22} className="animate-spin" />
        <p className="text-sm">{label}</p>
      </div>
    </div>
  );
}

export default function CollabArtifact({
  documentId,
  editable = true,
}: {
  documentId: string;
  editable?: boolean;
}) {
  const [conn, setConn] = useState<CollabConn | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setConn(null);
    setError(null);
    (async () => {
      try {
        const r = await docCollabConnFn({ data: { documentId } });
        if (cancelled) return;
        if (r.ok) setConn(r.conn);
        else setError(r.error);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [documentId]);

  // Token + sectionId estables para el callback de persistencia (no re-crear el editor).
  const tokenRef = useRef("");
  const sectionRef = useRef("page-1");
  if (conn) {
    tokenRef.current = conn.token;
    sectionRef.current = conn.persistSectionId;
  }

  if (error) {
    return (
      <div className="grid h-full place-items-center bg-[#f3f3f5] p-6 text-center text-sm text-neutral-500">
        No se pudo conectar a la co-edición.
        <br />
        <span className="text-xs text-neutral-400">{error}</span>
      </div>
    );
  }
  if (!conn) return <Spinner label="Conectando a la co-edición…" />;

  return (
    <Suspense fallback={<Spinner label="Cargando editor…" />}>
      <CollabEditor
        wsUrl={conn.wsUrl}
        room={conn.room}
        token={conn.token}
        initialHtml={conn.initialHtml}
        editable={editable}
        onSnapshot={(html) =>
          persistDocSectionFn({
            data: { token: tokenRef.current, sectionId: sectionRef.current, html },
          }).catch((e) => console.error("[collab] persist failed", e))
        }
      />
    </Suspense>
  );
}
