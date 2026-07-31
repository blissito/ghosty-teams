import { createFileRoute } from "@tanstack/react-router";

// Estado Yjs de un documento — el sidecar Hocuspocus (`ghosty-collab`, :9400) lo lee al
// abrir el room y lo escribe debounced tras las ediciones.
//
// Antes esto vivía en EasyBits (`/api/v2/collab/:docId/state`). GTeams corre en su propia
// micro-nube, así que el estado se queda en casa: en el sobre del documento, columna que
// ya estaba reservada (`yUpdate`). Ver `collab-state.server.ts`.
//
// Auth = Bearer COLLAB_SECRET, server-to-server. No hay sesión aquí: quien llama es el
// sidecar, y el permiso del HUMANO ya se decidió al mintear su ticket (`collab-ticket`).
// El secreto es el mismo con el que se firman los tickets, así que si falta, la
// co-edición entera está apagada y esto responde 503 en vez de servir datos sin puerta.

function guard(request: Request): Response | null {
  const secret = process.env.COLLAB_SECRET;
  if (!secret) return new Response("collab off", { status: 503 });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  return null;
}

export const Route = createFileRoute("/api/collab/$docId/state")({
  server: {
    handlers: {
      // 204 = documento sin estado previo; el editor lo siembra desde los bloques.
      GET: async ({ params, request }) => {
        const bad = guard(request);
        if (bad) return bad;
        const { loadYState } = await import("../server/collab-state.server");
        const state = await loadYState(params.docId);
        if (!state) return new Response(null, { status: 204 });
        // `Uint8Array` no es `BodyInit` para TS aunque el runtime lo acepte; el buffer sí.
        return new Response(state.buffer as ArrayBuffer, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      },

      PUT: async ({ params, request }) => {
        const bad = guard(request);
        if (bad) return bad;
        const body = new Uint8Array(await request.arrayBuffer());
        if (!body.byteLength) return new Response("empty", { status: 400 });
        const { saveYState } = await import("../server/collab-state.server");
        await saveYState(params.docId, body);
        return new Response(null, { status: 204 });
      },
    },
  },
});
