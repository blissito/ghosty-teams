import { createFileRoute } from "@tanstack/react-router";

// GET /artefacto/<slug>/raw → el HTML del artefacto compartido, para el iframe de /artefacto/<slug>.
// Sirve desde gc_artifacts.md (la VERDAD), no desde storage: así respeta la versión
// congelada y el permiso, cosa que /t3/<key> no puede hacer (una key de storage es
// pública para quien la tenga y siempre es una versión concreta suelta).
//
// El chrome de /artefacto/<slug> vive FUERA de este documento; aquí sólo entra el HTML del
// agente, aislado igual que en el panel: `sandbox` sin allow-same-origin → origen
// opaco, sin acceso a las cookies ni al DOM de ghosty.studio.
export const Route = createFileRoute("/artefacto/$id/raw")({
  server: {
    handlers: {
      GET: async ({ params, request }: { params: { id: string }; request: Request }) => {
        const notFound = () => new Response("not found", { status: 404 });
        if (!params.id) return notFound();

        // Sesión opcional: el dueño puede ver su artefacto privado; un visitante sin
        // sesión sólo pasa si está en "cualquiera con el link".
        let meSub: string | null = null;
        try {
          const { useSession } = await import("@tanstack/react-start/server");
          const { sessionConfig } = await import("../server/session.server");
          const s = await useSession<{ user?: { sub: string } }>(sessionConfig());
          meSub = s.data.user?.sub ?? null;
        } catch {
          /* sin sesión → visitante anónimo */
        }

        // Un fallo al resolver (workspace inexistente, DB caída) sale como 404 y no
        // como un 500 crudo: esta ruta la abre gente de fuera, y en un host donde el
        // artefacto no puede existir la respuesta honesta es "no está".
        let found: Awaited<ReturnType<typeof import("../server/artifacts").resolveSharedArtifact>>;
        try {
          const { resolveSharedArtifact } = await import("../server/artifacts");
          // Misma `?v` que el marco (ver artefacto.$id.tsx): el iframe tiene que entregar
          // exactamente la versión que la página anunció.
          const v = new URL(request.url).searchParams.get("v");
          found = await resolveSharedArtifact(params.id, meSub, v);
        } catch (e) {
          console.error("[artifact share] resolve falló", e);
          return notFound();
        }
        if (!found?.version.md) return notFound();

        return new Response(found.version.md, {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy":
              "sandbox allow-scripts allow-forms allow-popups allow-modals; base-uri 'none'",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            // Privado NO se cachea en intermediarios: el permiso puede revocarse.
            "Cache-Control":
              found.root.visibility === "link" ? "public, max-age=60" : "private, no-store",
          },
        });
      },
    },
  },
});
