import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { History } from "lucide-react";
import { createServerFn } from "@tanstack/react-start";
import ArtifactShareBar from "../components/ArtifactShareBar";
import ArtifactHistoryPanel from "../components/ArtifactHistoryPanel";
import GhostyMascot, { blinkTiming } from "../components/GhostyMascot";
import { useT } from "../i18n";

// Página PÚBLICA de un artefacto compartido: /artefacto/<slug>.
//
// El marco (título, autor, versión, Compartir) vive FUERA del sandbox y el HTML del
// agente entra en un iframe hacia /artefacto/<slug>/raw. Al revés —inyectando la barra
// dentro del documento— el CSS del agente podría pisarla o esconderla, y además
// habría que confiar en el HTML para pintar controles nuestros.
//
// El permiso lo aplica el servidor en las DOS rutas (resolveSharedArtifact): esta
// pinta el marco, y la de raw es la que realmente entrega el contenido.

const loadShared = createServerFn({ method: "GET" })
  .validator((d: { slug: string; v?: string | null }) => d)
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

    // Igual que en /raw: un fallo al resolver se trata como "no existe" (el loader
    // lo convierte en 404) en vez de reventar con un 500 sin explicación.
    let found: Awaited<ReturnType<typeof import("../server/artifacts").resolveSharedArtifact>>;
    try {
      const { resolveSharedArtifact } = await import("../server/artifacts");
      found = await resolveSharedArtifact(data.slug, meSub, data.v ?? null);
    } catch (e) {
      console.error("[artifact share] resolve falló", e);
      return null;
    }
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
      // El HTML lo sirve el CDN (artefacto.ghosty.studio/<key>), NO la DB: para eso
      // existe ese subdominio. La DB se toca UNA vez, aquí, para armar el marco;
      // las visitas al contenido no la tocan.
      // `src` null = fila vieja publicada antes de que hubiera storage → se cae a
      // /artefacto/<slug>/raw, que sí lee de la DB. Es el camino de excepción.
      // …pero SÓLO cuando es público. El iframe pide el CDN como recurso cross-site y con
      // `no-referrer`: no viaja ninguna cookie, así que ahí nadie es el dueño y el guard de
      // permisos de /t3 responde 404 — hasta al propio dueño mirando su artefacto privado.
      // Privado va por /raw, que es del mismo origen y sí ve la sesión.
      contentUrl: found.root.visibility === "link" ? found.version.src : null,
      versionId: found.version.id,
      // El iframe pide la MISMA versión que el marco: si no, el /raw resolvería por su
      // cuenta y podría entregar otra.
      viewParam: data.v ? `?v=${encodeURIComponent(data.v)}` : "",
    };
  });

export const Route = createFileRoute("/artefacto/$id")({
  // Sin caché: el permiso y la versión compartida cambian desde el propio diálogo,
  // y servir el loader viejo enseñaba el documento anterior tras cambiarlos.
  staleTime: 0,
  gcTime: 0,
  // `?v=latest` (o el id de una versión) = "enséñame ésta". El panel lo pone al abrir en
  // pestaña nueva: lo que se abre debe ser lo que estabas viendo, no lo que esté fijado
  // para quien reciba el enlace.
  // OJO: el router parsea los search params como JSON, así que `?v=113` llega como
  // NÚMERO. Exigir string hacía que el validador lo descartara y el router redirigiera
  // (307) a la URL "canónica" SIN el parámetro — por eso `?v=latest` funcionaba y el id
  // de una versión no. Se normaliza a texto y ya.
  // El router parsea los search params como JSON (`?v=113` llega como NÚMERO) y
  // REESCRIBE la URL si el validador devuelve algo distinto de lo que entró: exigir
  // string tiraba el parámetro (307 a la URL sin `?v`) y normalizarlo a texto lo dejaba
  // como `?v="113"`. Se pasa tal cual y se convierte a texto donde se usa.
  validateSearch: (search: Record<string, unknown>) => ({
    v: search.v as string | number | undefined,
  }),
  loaderDeps: ({ search }) => ({ v: search.v }),
  loader: async ({ params, deps }) => {
    const data = await loadShared({ data: { slug: params.id, v: deps.v == null ? null : String(deps.v) } });
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
  const router = useRouter();
  const navigate = Route.useNavigate();
  const { id } = Route.useParams();
  const d = Route.useLoaderData();
  // La versión pedida se lee del NAVEGADOR, no de lo que el loader haya resuelto: es el
  // dato que el usuario tiene en la barra de direcciones, y es el que el iframe debe
  // pedirle a /raw para que marco y contenido no puedan discrepar.
  const search = Route.useSearch();
  // El parpadeo se siembra con el slug: estable entre render y render (nada de
  // Math.random, que rompería la hidratación) y distinto por artefacto.
  const blink = blinkTiming(id);
  const [historial, setHistorial] = useState(false);

  // El FRAGMENTO se le pasa al artefacto. Es suyo: nunca viaja al servidor, y de todo lo
  // que hay en la URL es lo único que el contenido no puede averiguar por su cuenta —el
  // iframe corre en un origen opaco y no puede leer la barra de direcciones de esta página.
  // Lo estrena "guardar y continuar" de los formularios (`#d=<token>`), pero es genérico.
  // Se captura UNA vez, al montar: el `key` del iframe lo remonta con cada cambio de src, y
  // no queremos que un cambio de hash tire el documento que la persona está llenando.
  const [hash] = useState(() => (typeof window === "undefined" ? "" : window.location.hash));

  // SAFE-AREA. El root declara `viewport-fit=cover`, así que en un teléfono con muesca la
  // página ocupa TODA la pantalla — y sin este padding el título de la barra quedaba
  // debajo del reloj y de los íconos de batería/wifi, ilegible.
  // `md:pt-0` porque en escritorio el inset es 0 y el padding sólo estorbaría; mismo
  // patrón que el shell de rooms (c.$slug.tsx).
  // El inset de ABAJO va en el contenedor del iframe, no acá: este flex es `h-[100dvh]` y
  // meterle padding inferior le quitaría altura útil al artefacto en vez de correrlo.
  return (
    <div className="flex h-[100dvh] flex-col bg-surface pt-[env(safe-area-inset-top)] md:pt-0">
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
        // Elegir otra versión se refleja en la URL — el `?v` es quien decide qué se ve,
        // así que navegar es lo que hace que la página cambie de verdad (y deja el
        // enlace de la barra listo para copiar tal cual).
        onShareChange={(s) => {
          navigate({ search: { v: s.sharedArtifactId ?? undefined }, replace: true });
          router.invalidate();
        }}
        // Historial: aquí SÍ navega, porque el `?v` es lo que decide qué se ve. En el
        // panel de Teams el mismo componente es informativo (ahí se ve el documento vivo).
        actions={
          <span className="relative shrink-0">
            <button
              type="button"
              onClick={() => setHistorial((v) => !v)}
              title={t("Historial de versiones")}
              aria-pressed={historial}
              className={`grid size-7 place-items-center rounded-md transition ${
                historial ? "bg-brand/10 text-brand" : "text-muted hover:bg-surface-3 hover:text-brand"
              }`}
            >
              <History size={15} />
            </button>
            {historial ? (
              <ArtifactHistoryPanel
                documentId={d.documentId}
                // `?v` puede llegar como número o como texto (el router lo parsea como
                // JSON y aquí se pasa tal cual); el panel compara contra ids numéricos.
                actual={search.v == null ? null : Number(search.v)}
                onClose={() => setHistorial(false)}
                onSelect={(versionId) => {
                  setHistorial(false);
                  navigate({ search: { v: versionId ?? undefined }, replace: true });
                  router.invalidate();
                }}
              />
            ) : null}
          </span>
        }
      />
      <iframe
        // REMONTAR al cambiar de versión: cambiarle el src a un iframe vivo no
        // siempre lo recarga (queda el documento anterior). Con `key` React lo tira
        // y lo crea de nuevo, que es lo único que garantiza ver la otra versión.
        key={search.v ?? d.versionId}
        title={d.title}
        // CDN primero (artefacto.ghosty.studio/<key>): el contenido no pasa por la
        // app ni por la DB. El /raw sólo entra para filas viejas sin `src`.
        src={
          (search.v != null
            ? `/artefacto/${encodeURIComponent(id)}/raw?v=${encodeURIComponent(String(search.v))}`
            : d.contentUrl || `/artefacto/${encodeURIComponent(id)}/raw`) + hash
        }
        sandbox="allow-scripts allow-forms allow-popups"
        referrerPolicy="no-referrer"
        // El fondo NO es blanco: al cambiar de versión el iframe se remonta y, mientras
        // carga, ese blanco era un flashazo entre dos documentos oscuros. El color del
        // marco no destella contra nada.
        // El inset de ABAJO va aquí y no en el flex de fuera: el contenedor es `h-[100dvh]`
        // y un padding suyo le quitaría altura al artefacto en vez de despegarlo del home
        // indicator del teléfono.
        className="min-h-0 flex-1 border-0 bg-surface pb-[env(safe-area-inset-bottom)] md:pb-0"
      />
    </div>
  );
}
