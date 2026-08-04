import { createFileRoute } from "@tanstack/react-router";

// Fin de una sesión de co-edición: el sidecar avisa cuando la sala se queda SIN NADIE.
//
// Es el corte del historial. `yUpdate` es ESTADO (se sobrescribe en cada guardado), así
// que por sí solo no deja rastro: sin esto, una tarde entera de co-edición no produce ni
// una versión y el documento sólo tiene la última foto. Cortar al vaciarse la sala da
// versiones con sentido —"lo que dejaron al terminar"— en vez de cientos de
// microsnapshots, y reusa el historial que el panel ya sabe navegar.
//
// Auth = Bearer COLLAB_SECRET (server-to-server), igual que /state.

export const Route = createFileRoute("/api/collab/$docId/session-end")({
  server: {
    handlers: {
      POST: async ({ params, request }) => {
        const secret = process.env.COLLAB_SECRET;
        if (!secret) return new Response("collab off", { status: 503 });
        if (request.headers.get("authorization") !== `Bearer ${secret}`) {
          return new Response("unauthorized", { status: 401 });
        }
        // El sidecar manda a quiénes autenticó en esta sesión. Es opcional a propósito:
        // un sidecar viejo (o un cuerpo vacío) sigue cortando versión, sólo que sin firmar.
        let participantes: string[] = [];
        try {
          const body = (await request.json()) as { participants?: unknown };
          if (Array.isArray(body?.participants)) {
            participantes = body.participants.filter((x): x is string => typeof x === "string");
          }
        } catch {
          /* sin cuerpo */
        }
        // ⚠️ El tenant TIENE que venir en el header: el sidecar llama por loopback, aquí
        // no hay subdominio, y `currentNamespace()` caería a `SQLD_NAMESPACE` — el
        // namespace de un workspace real. Esto PUBLICA UNA VERSIÓN del documento, así que
        // adivinar mal significa escribir el trabajo de un cliente en la base de otro.
        // El Bearer no distingue nada: `COLLAB_SECRET` es global. Ver sidecar/server.js.
        const ns = request.headers.get("x-gt-ns");
        if (!ns) return new Response("falta x-gt-ns", { status: 400 });
        const { withNamespace } = await import("../server/tenant.server");
        return withNamespace(ns, async () => {
          const { ensureSchema } = await import("../server/schema.server");
          await ensureSchema();
          const { cerrarSesionDeCoedicion } = await import("../server/collab-state.server");
          const r = await cerrarSesionDeCoedicion(params.docId, participantes);
          return new Response(JSON.stringify(r), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        });
      },
    },
  },
});
