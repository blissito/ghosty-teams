import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Layers, Sparkles, Upload, Hash, Lock, MessageCircle } from "lucide-react";
import { useLocale, useT } from "../i18n";
import { intlLocale } from "../i18n.core";
import { me } from "../server/auth";
import { listTeamDocumentsFn, type TeamDocument } from "../server/documents";
import { FileGlyph, glyphNameFor } from "../components/FileGlyph";
// ⚠️ `docToView` se IMPORTA, no se copia. `artifacts.tsx` tenía su propia versión y se
// quedó atrás: sin la rama de imagen (las imágenes salían como «Descargar») y sin la de
// documentos generados y hospedados (tiles inertes). El índice DENTRO de un room usaba la
// buena, así que el mismo documento abría ahí y no aquí. La duplicación era el bug.
import ArtifactPanel, { docToView, type ArtifactView } from "../components/ArtifactPanel";

// Estudio de artefactos / Documentos del team (Cowork): todos los documentos del
// team en tiles — los GENERADOS por el agente (eb-doc en vivo) y los SUBIDOS al
// chat (pdf/office, ya en EasyBits privado). Clic en un tile = ver en el panel.
// Patrón: forms.tsx (cache de módulo + loader auth + carga client-side).
let docsCache: TeamDocument[] | null = null;

export const Route = createFileRoute("/artifacts")({
  loader: async () => ({ user: await me() }),
  component: ArtifactsPage,
});

function fmtDate(ts: number, locale: string): string {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleDateString(locale, { day: "numeric", month: "short" });
}
function fmtSize(bytes?: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function DocTile({ d, onOpen }: { d: TeamDocument; onOpen: (v: ArtifactView) => void }) {
  const t = useT();
  const locale = useLocale();
  const view = docToView(d);
  return (
    <button
      type="button"
      onClick={() => (view ? onOpen(view) : undefined)}
      className={`group flex items-start gap-3 rounded-2xl gt-card p-4 text-left transition hover:border-brand/60 hover:bg-surface-3 ${view ? "cursor-pointer" : "cursor-default"}`}
    >
      <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-surface-3">
        <FileGlyph className="h-7 w-[1.4rem]" mime={d.mime} name={glyphNameFor(d.title, d.kind)} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-semibold text-ink">{d.title}</div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <span className="inline-flex items-center gap-1">
            {d.source === "generated" ? <><Sparkles size={11} /> {t("Redactado")}</> : <><Upload size={11} /> {t("Subido")}</>}
          </span>
          <span className="uppercase tracking-wide">{d.kind === "sheet" ? t("hoja") : d.kind}</span>
          {d.size ? <span>· {fmtSize(d.size)}</span> : null}
          {d.createdAt ? <span>· {fmtDate(d.createdAt, intlLocale(locale))}</span> : null}
        </div>
      </div>
    </button>
  );
}

type DocGroup = {
  key: string;
  /** Presente si el grupo es un DM. Su enlace no es un room: los DMs se abren con
   *  `/c/$slug?dm=<id>` (ver `validateSearch` en `c.$slug.tsx`). */
  dmId?: number;
  channelName: string | null;
  channelSlug: string | null;
  /** Marca de quién más lo ve. Viene resuelta del servidor. */
  audience?: TeamDocument["audience"];
  audienceNames?: string[];
  docs: TeamDocument[];
};


// Quién MÁS ve los documentos de este grupo. Sin marca = canal público.
//
// Tres textos y no uno: «Sólo tú» en un DM de dos personas, o en un canal privado con
// miembros, es falso — y es justo el error que hace que alguien comparta de más creyendo
// que no lo ve nadie.
function AudienceBadge({ audience, names }: { audience?: TeamDocument["audience"]; names?: string[] }) {
  const t = useT();
  if (!audience) return null;
  const label =
    audience === "solo"
      ? t("Sólo tú")
      : audience === "conmigo"
        ? `${t("Tú y")} ${(names ?? []).join(", ")}`
        : t("Privado");
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-3 px-2 py-0.5 text-[11px] text-muted">
      <Lock size={10} className="shrink-0" /> {label}
    </span>
  );
}

function ArtifactsPage() {
  const t = useT();
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
    // ⚠️ La clave es STRING y lleva el espacio ("dm:" / "ch:"). Con el `channelId` a
    // secas, TODOS los documentos de DM caen en el grupo `0` —un mensaje de DM tiene
    // `channel_id = 0`— y se mezclan los de conversaciones distintas bajo «Sin caso».
    const map = new Map<string, DocGroup>();
    for (const d of docs) {
      const key = d.dmId ? `dm:${d.dmId}` : `ch:${d.channelId}`;
      let g = map.get(key);
      if (!g) {
        g = {
          key,
          dmId: d.dmId,
          channelName: d.channelName,
          channelSlug: d.channelSlug,
          audience: d.audience,
          audienceNames: d.audienceNames,
          docs: [],
        };
        map.set(key, g);
      }
      g.docs.push(d);
    }
    return [...map.values()];
  }, [docs]);

  return (
    // ⚠️ `h-[100dvh]`, NO `min-h-`. El panel lleva `lg:self-stretch`, así que se estira a
    // la altura del contenedor; con `min-h-` ese contenedor crece con la lista (decenas de
    // tiles = miles de px) y el panel salía altísimo, con el documento perdido a media de
    // un scroll gigante. La columna de la izquierda ya es `overflow-auto` y es la que
    // scrollea. Mismo patrón que el room (`c.$slug.tsx`).
    <div className="flex h-[100dvh] overflow-hidden bg-surface text-ink">
      <div className="min-w-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-4xl px-5 py-8">
          <Link to="/c/$slug" params={{ slug: "general" }} className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
            <ArrowLeft size={15} /> {t("Volver al chat")}
          </Link>
          <header className="mb-6">
            <h1 className="flex items-center gap-2 text-2xl font-bold"><Layers size={22} className="text-brand" /> {t("Documentos")}</h1>
            <p className="mt-1 text-sm text-muted">
              {t("Todos los documentos del team: los que redacta @ghosty y los que arrojas al chat. Haz clic para verlos.")}
            </p>
          </header>

          {docs === null ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="animate-pulse rounded-2xl gt-card p-4">
                  <div className="mb-3 h-5 w-2/3 rounded bg-surface-3" />
                  <div className="h-3 w-1/3 rounded bg-surface-3" />
                </div>
              ))}
            </div>
          ) : docs.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border p-10 text-center text-sm text-muted">
              <p className="mb-1 font-semibold text-ink">{t("Aún no hay documentos")}</p>
              <p>{t("Pídele a")} <span className="text-brand">@ghosty</span> {t("que redacte algo, o arroja un PDF/Word al chat.")}</p>
            </div>
          ) : (
            // Matter-centric: agrupado por CASO (room). Cada sección = los docs de un
            // expediente (generados + subidos), unificados. Solo rooms que puedes ver.
            <div className="flex flex-col gap-8">
              {groups!.map((g) => (
                <section key={g.key}>
                  <div className="mb-3 flex items-center gap-2 border-b border-border/70 pb-2">
                    {g.dmId ? (
                      <MessageCircle size={15} className="shrink-0 text-brand" />
                    ) : (
                      <Hash size={15} className="shrink-0 text-brand" />
                    )}
                    {g.dmId ? (
                      <Link
                        to="/c/$slug"
                        params={{ slug: "general" }}
                        search={{ dm: g.dmId }}
                        className="truncate text-sm font-semibold text-ink hover:text-ink"
                      >
                        {g.channelName ?? "Mensaje directo"}
                      </Link>
                    ) : g.channelSlug ? (
                      <Link to="/c/$slug" params={{ slug: g.channelSlug }} className="truncate text-sm font-semibold text-ink hover:text-ink">
                        {g.channelName ?? g.channelSlug}
                      </Link>
                    ) : (
                      <span className="truncate text-sm font-semibold text-ink">{g.channelName ?? "Sin caso"}</span>
                    )}
                    <span className="text-xs text-faint">· {g.docs.length}</span>
                    <AudienceBadge audience={g.audience} names={g.audienceNames} />
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
