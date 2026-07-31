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
        const { cerrarSesionDeCoedicion } = await import("../server/collab-state.server");
        const r = await cerrarSesionDeCoedicion(params.docId);
        return new Response(JSON.stringify(r), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
