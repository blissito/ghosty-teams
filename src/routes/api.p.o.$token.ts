import { createFileRoute } from "@tanstack/react-router";

// GET /api/p/o/<token> → pixel de apertura de un correo de prospección.
//
// ⚠️ SIEMPRE responde el GIF, incluso si el token no resuelve o la DB está caída. Un pixel
// que devuelve 404 o 500 se ve COMO UNA IMAGEN ROTA en el correo del prospecto: el
// destinatario ve un cuadro gris con una cruz al finalHtml del mensaje. Que no podamos medir
// una apertura es un problema nuestro; que se le rompa el correo a él, no.
//
// Sin caché por la misma razón de siempre: Gmail sirve las imágenes from su proxy y las
// guarda, así que sin estas cabeceras sólo se contaría la PRIMERA apertura de cada
// destinatario y ninguna posterior.
export const Route = createFileRoute("/api/p/o/$token")({
  server: {
    handlers: {
      GET: async ({ params }: { params: { token: string } }) => {
        const { PIXEL_GIF, verifyTrackToken } = await import("../server/prospeccion/track.server");

        // El registro va en segundo plano y nunca bloquea la respuesta.
        try {
          const c = verifyTrackToken(params.token || "");
          if (c && c.kind === "open") {
            const { withNamespace } = await import("../server/tenant.server");
            await withNamespace(c.ns, async () => {
              const { markEvent } = await import("../server/prospeccion/touches.server");
              const r = await markEvent(c.touchId, "opened");
              if (r) {
                const { publish, ch } = await import("../server/bus.server");
                // `refresh` y no `message:new`: cambió un estado, no hay mensaje nuevo. Un
                // `message:new` por cada apertura despertaría al agente y llenaría el chat.
                publish(ch.presence(c.ns), { t: "refresh", channelId: null, parentId: null });
              }
            });
          }
        } catch {
          // Deliberadamente mudo: ver el comentario de arriba.
        }

        return new Response(new Uint8Array(PIXEL_GIF), {
          status: 200,
          headers: {
            "Content-Type": "image/gif",
            "Content-Length": String(PIXEL_GIF.length),
            "Cache-Control": "no-store, no-cache, must-revalidate, private",
            Pragma: "no-cache",
            Expires: "0",
          },
        });
      },
    },
  },
});
