import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Layers, Plus } from "lucide-react";
import { me } from "../server/auth";

// SCAFFOLD (WIP — mañana se trabaja). "Estudio de artefactos" del team: crear y
// GUARDAR artefactos (doc/sheet/office/…) en el propio GTeams, listados aquí debajo
// de Formularios. Hoy es un stub: nav + página placeholder + plan de persistencia.
// Diseño y pendientes en docs/ARTIFACTS-STUDIO.md.
export const Route = createFileRoute("/artifacts")({
  loader: async () => ({ user: await me() }),
  component: ArtifactsPage,
});

function ArtifactsPage() {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-4 py-6">
      <div className="mb-6 flex items-center gap-3">
        <Link to="/" className="rounded-lg p-2 text-muted hover:bg-surface-3 hover:text-ink">
          <ArrowLeft size={18} />
        </Link>
        <Layers size={20} className="text-brand" />
        <h1 className="text-lg font-semibold text-ink">Artefactos</h1>
        <span className="rounded-full border border-border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
          WIP
        </span>
      </div>

      <div className="rounded-2xl border border-dashed border-border bg-surface-2 p-8 text-center">
        <Layers size={36} className="mx-auto mb-3 text-muted" />
        <p className="text-sm font-medium text-ink">Estudio de artefactos (próximamente)</p>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted">
          Aquí podrás crear artefactos (documentos, hojas, PDFs, sitios) y guardarlos en
          este team. Se listarán en esta sección, debajo de Formularios.
        </p>
        <button
          type="button"
          disabled
          className="mx-auto mt-5 inline-flex cursor-not-allowed items-center gap-2 rounded-xl bg-brand/40 px-4 py-2 text-sm font-semibold text-white opacity-60"
          title="Mañana lo construimos"
        >
          <Plus size={16} /> Nuevo artefacto
        </button>
      </div>

      {/* Pendientes de implementación (ver docs/ARTIFACTS-STUDIO.md):
          1. Tabla gc_artifacts (o reutilizar la de doc-artefactos) + server fns CRUD.
          2. listTeamArtifactsFn → poblar esta lista (patrón listTeamFormsFn).
          3. createArtifactFn: mint editor colab (mintCollabEmbed) o doc EasyBits vía
             platform key, guardar ref local, abrir en el panel/editor.
          4. Card por artefacto (kind, título, updated) + abrir en ArtifactPanel. */}
    </div>
  );
}
