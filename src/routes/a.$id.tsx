import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import ArtifactShareBar from "../components/ArtifactShareBar";
import GhostyMascot, { blinkTiming } from "../components/GhostyMascot";
import { useT } from "../i18n";

// Página PÚBLICA de un artefacto compartido: /a/<slug>.
//
// El marco (título, autor, versión, Compartir) vive FUERA del sandbox y el HTML del
// agente entra en un iframe hacia /a/<slug>/raw. Al revés —inyectando la barra
// dentro del documento— el CSS del agente podría pisarla o esconderla, y además
// habría que confiar en el HTML para pintar controles nuestros.
//
// El permiso lo aplica el servidor en las DOS rutas (resolveSharedArtifact): esta
// pinta el marco, y la de raw es la que realmente entrega el contenido.

const loadShared = createServerFn({ method: "GET" })
  .validator((d: { slug: string }) => d)
  .handler(async ({ data }) => {
    const { useSession } = await import("@tanstack/react-start/server");
    const { sessionConfig } = await import("../server/session.server");
    let meSub: string | null = null;
    try {
      const s = await useSession<{ user?: { sub: string } }>(sessionConfig());
      meSub = s.data.user?.sub ?? null;
    } catch {
      /* visitante anónimo */
    }

    const { resolveSharedArtifact } = await import("../server/artifacts");
    const found = await resolveSharedArtifact(data.slug, meSub);
    if (!found) return null;

    // Nombre del dueño para el "Artefacto de …". No se manda el correo: esta
    // página la puede abrir cualquiera con el link.
    let ownerName: string | null = null;
    if (found.root.ownerSub) {
      const { dbq } = await import("../dbq.server");
      const rows = await dbq(`SELECT name FROM gc_users WHERE sub = ? LIMIT 1`, [found.root.ownerSub]);
      ownerName = rows[0]?.name ?? null;
    }

    return {
      documentId: found.root.url,
      title: found.version.title || "Artefacto",
      ownerName,
      versionLabel: found.versionLabel,
      isOwner: found.isOwner,
      visibility: found.root.visibility,
    };
  });

export const Route = createFileRoute("/a/$id")({
  loader: async ({ params }) => {
    const data = await loadShared({ data: { slug: params.id } });
    // Sin acceso y no existe se responden IGUAL: un 403 confirmaría que el
    // artefacto existe, que ya es información sobre alguien más.
    if (!data) throw notFound();
    return data;
  },
  head: ({ loaderData }) => {
    const title = loaderData?.title ?? "Artefacto";
    const desc = loaderData?.ownerName
      ? `Un artefacto de ${loaderData.ownerName}, hecho en Ghosty Teams.`
      : "Un artefacto hecho en Ghosty Teams.";
    return {
      meta: [
        { title },
        { property: "og:title", content: title },
        { property: "og:description", content: desc },
        { name: "twitter:title", content: title },
        { name: "twitter:description", content: desc },
        // Privado: que no lo indexen aunque el link se filtre a un crawler.
        ...(loaderData?.visibility === "link" ? [] : [{ name: "robots", content: "noindex, nofollow" }]),
      ],
    };
  },
  component: SharedArtifact,
});

function SharedArtifact() {
  const t = useT();
  const { id } = Route.useParams();
  const d = Route.useLoaderData();
  // El parpadeo se siembra con el slug: estable entre render y render (nada de
  // Math.random, que rompería la hidratación) y distinto por artefacto.
  const blink = blinkTiming(id);

  return (
    <div className="flex h-[100dvh] flex-col bg-surface">
      <ArtifactShareBar
        // La marca de la página es el fantasmita, no un ícono de archivo: esta
        // página la abre gente que quizá no conoce Ghosty.
        leading={
          <GhostyMascot className="mr-1.5 h-6 w-5 shrink-0" offset={blink.offset} period={blink.period} />
        }
        title={d.title}
        subtitle={d.ownerName ? t("Artefacto de {name}").replace("{name}", d.ownerName) : null}
        versionLabel={d.versionLabel}
        // Compartir sólo lo ve el dueño: a un visitante no le sirve un panel de
        // permisos que no puede tocar.
        documentId={d.isOwner ? d.documentId : null}
      />
      <iframe
        title={d.title}
        src={`/a/${encodeURIComponent(id)}/raw`}
        sandbox="allow-scripts allow-forms allow-popups"
        referrerPolicy="no-referrer"
        className="min-h-0 flex-1 border-0 bg-white"
      />
    </div>
  );
}
