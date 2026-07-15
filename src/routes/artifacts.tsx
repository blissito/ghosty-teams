import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Layers, FileText, FileSpreadsheet, Sparkles, Upload, Hash } from "lucide-react";
import { me } from "../server/auth";
import { listTeamDocumentsFn, type TeamDocument } from "../server/documents";
import ArtifactPanel, { type ArtifactView } from "../components/ArtifactPanel";

// Estudio de artefactos / Documentos del team (Cowork): todos los documentos del
// team en tiles — los GENERADOS por el agente (eb-doc en vivo) y los SUBIDOS al
// chat (pdf/office, ya en EasyBits privado). Clic en un tile = ver en el panel.
// Patrón: forms.tsx (cache de módulo + loader auth + carga client-side).
let docsCache: TeamDocument[] | null = null;

export const Route = createFileRoute("/artifacts")({
  loader: async () => ({ user: await me() }),
  component: ArtifactsPage,
});

function fmtDate(ts: number): string {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleDateString("es-MX", { day: "numeric", month: "short" });
}
function fmtSize(bytes?: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Un documento del team → vista para el ArtifactPanel. Devuelve null si no es
// previsualizable (el tile cae a "ver en el room").
function toView(d: TeamDocument): ArtifactView | null {
  if (d.source === "uploaded" && d.fileId) {
    const src = `/api/attachment/${encodeURIComponent(d.fileId)}`;
    if (d.kind === "pdf") return { kind: "pdf", title: d.title, src };
    if (d.kind === "office") return { kind: "office", title: d.title, src };
    return { kind: "file", title: d.title, src };
  }
  if (d.kind === "doc") return { kind: "doc", title: d.title, documentId: d.documentId ?? d.key, md: d.md ?? "" };
  if (d.kind === "sheet") return { kind: "sheet", title: d.title, documentId: d.documentId ?? d.key, csv: d.md ?? "" };
  if (d.kind === "html" && d.documentId) return { kind: "html", title: d.title, embedUrl: d.documentId };
  return null;
}

function DocIcon({ kind }: { kind: TeamDocument["kind"] }) {
  const cls = "text-brand";
  if (kind === "sheet") return <FileSpreadsheet size={22} className={cls} />;
  return <FileText size={22} className={cls} />;
}

function DocTile({ d, onOpen }: { d: TeamDocument; onOpen: (v: ArtifactView) => void }) {
  const view = toView(d);
  return (
    <button
      type="button"
      onClick={() => (view ? onOpen(view) : undefined)}
      className={`group flex items-start gap-3 rounded-2xl border border-border bg-surface-2 p-4 text-left transition hover:border-brand/60 hover:bg-surface-3 ${view ? "cursor-pointer" : "cursor-default"}`}
    >
      <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-surface-3">
        <DocIcon kind={d.kind} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-semibold text-ink">{d.title}</div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <span className="inline-flex items-center gap-1">
            {d.source === "generated" ? <><Sparkles size={11} /> Redactado</> : <><Upload size={11} /> Subido</>}
          </span>
          <span className="uppercase tracking-wide">{d.kind === "sheet" ? "hoja" : d.kind}</span>
          {d.size ? <span>· {fmtSize(d.size)}</span> : null}
          {d.createdAt ? <span>· {fmtDate(d.createdAt)}</span> : null}
        </div>
      </div>
    </button>
  );
}

type DocGroup = { channelId: number; channelName: string | null; channelSlug: string | null; docs: TeamDocument[] };

function ArtifactsPage() {
  const [docs, setDocs] = useState<TeamDocument[] | null>(docsCache);
  const [openArtifact, setOpenArtifact] = useState<ArtifactView | null>(null);

  useEffect(() => {
    let alive = true;
    listTeamDocumentsFn()
      .then((d) => { if (!alive) return; docsCache = d; setDocs(d); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // Matter-centric: agrupa por caso (room). El orden por-doc (createdAt desc) hace
  // que los casos con actividad más reciente salgan primero.
  const groups = useMemo<DocGroup[] | null>(() => {
    if (!docs) return null;
    const map = new Map<number, DocGroup>();
    for (const d of docs) {
      let g = map.get(d.channelId);
      if (!g) { g = { channelId: d.channelId, channelName: d.channelName, channelSlug: d.channelSlug, docs: [] }; map.set(d.channelId, g); }
      g.docs.push(d);
    }
    return [...map.values()];
  }, [docs]);

  return (
    <div className="flex min-h-dvh bg-bg text-ink">
      <div className="min-w-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-4xl px-5 py-8">
          <Link to="/c/$slug" params={{ slug: "general" }} className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
            <ArrowLeft size={15} /> Volver al chat
          </Link>
          <header className="mb-6">
            <h1 className="flex items-center gap-2 text-2xl font-bold"><Layers size={22} className="text-brand" /> Documentos</h1>
            <p className="mt-1 text-sm text-muted">
              Todos los documentos del team: los que redacta @ghosty y los que arrojas al chat. Haz clic para verlos.
            </p>
          </header>

          {docs === null ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="animate-pulse rounded-2xl border border-border bg-surface-2 p-4">
                  <div className="mb-3 h-5 w-2/3 rounded bg-surface-3" />
                  <div className="h-3 w-1/3 rounded bg-surface-3" />
                </div>
              ))}
            </div>
          ) : docs.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border p-10 text-center text-sm text-muted">
              <p className="mb-1 font-semibold text-ink">Aún no hay documentos</p>
              <p>Pídele a <span className="text-brand">@ghosty</span> que redacte algo, o arroja un PDF/Word al chat.</p>
            </div>
          ) : (
            // Matter-centric: agrupado por CASO (room). Cada sección = los docs de un
            // expediente (generados + subidos), unificados. Solo rooms que puedes ver.
            <div className="flex flex-col gap-8">
              {groups!.map((g) => (
                <section key={g.channelId}>
                  <div className="mb-3 flex items-center gap-2 border-b border-border/70 pb-2">
                    <Hash size={15} className="shrink-0 text-brand" />
                    {g.channelSlug ? (
                      <Link to="/c/$slug" params={{ slug: g.channelSlug }} className="truncate text-sm font-semibold text-ink hover:text-ink">
                        {g.channelName ?? g.channelSlug}
                      </Link>
                    ) : (
                      <span className="truncate text-sm font-semibold text-ink">{g.channelName ?? "Sin caso"}</span>
                    )}
                    <span className="text-xs text-faint">· {g.docs.length}</span>
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {g.docs.map((d) => (
                      <DocTile key={d.key} d={d} onOpen={setOpenArtifact} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Visor del documento (mismo panel del room). */}
      <ArtifactPanel artifact={openArtifact} onClose={() => setOpenArtifact(null)} />
    </div>
  );
}
