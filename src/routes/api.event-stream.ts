import { createFileRoute } from "@tanstack/react-router";
import { alApagar } from "../server/shutdown.server";
import type { RtEvent } from "../server/bus.server";

// ── SSE de la sala de un evento ─────────────────────────────────────────────
//
// Gemelo público de `api.stream.ts`, y deliberadamente un endpoint APARTE en vez de
// una rama dentro de aquél. La razón no es de estilo: `api.stream.ts` suscribe a
// `bus.ch.presence(ns)` y lo PRIMERO que manda es `presence:init` con todos los
// conectados del tenant y sus nombres. Meter ahí una rama para desconocidos deja el
// directorio del cliente a un `if` mal puesto de distancia, y ese archivo se toca
// cada vez que se añade algo al realtime.
//
// Aquí la conexión alcanza EXACTAMENTE una cosa: el room del evento en el que quien
// llama está registrado. Nada de `ch.user`, nada de `ch.presence`, ninguna lista.

// Lo que un invitado puede recibir. LISTA BLANCA y no negra: `RtEvent` crece cada
// pocas semanas, y con una lista negra el evento nuevo se filtra solo — el fallo por
// omisión tiene que ser "no se manda", no "se manda".
//
// Fuera queda, sobre todo, `turn`: lleva `tarea`, que es el texto LITERAL de lo que
// una persona del equipo le pidió al agente, y `outcome`, que es lo que entregó.
// Fuera también `unread`/`star` (contabilidad de la pestaña de un miembro) y
// `artifact:open`, que es una orden sobre la pantalla de alguien.
const PARA_INVITADOS = new Set([
  "message:new",
  "message:delta",
  "message:body",
  "message:edited",
  "message:deleted",
  "reaction",
  "typing",
  "pin",
  "refresh",
  "event:presence",
]);

function visibleParaInvitado(ev: RtEvent): boolean {
  return PARA_INVITADOS.has(ev.t);
}

export const Route = createFileRoute("/api/event-stream")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const slug = new URL(request.url).searchParams.get("slug") ?? "";
        if (!slug) return new Response("bad request", { status: 400 });

        await (await import("../server/schema.server")).ensureSchema().catch(() => {});
        const db = await import("../db.server");
        const channel = await db.channelByShareSlug(slug);
        if (!channel) return new Response("not found", { status: 404 });

        // La MISMA puerta que la sala y el chat: cookie de invitado + fila de registro
        // no baneada, o miembro con acceso al room. Cero criterio de permiso nuevo —
        // si algún día se endurece el registro, esto se endurece con él.
        const { eventViewerFor } = await import("../server/events/access.server");
        const viewer = await eventViewerFor(channel);
        if (!viewer) return new Response("unauthorized", { status: 401 });

        const bus = await import("../server/bus.server");
        const { currentNamespace } = await import("../server/tenant.server");
        const ns = await currentNamespace();

        const enc = new TextEncoder();
        let unsub = () => {};
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        let desregistrar = () => {};

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (ev: RtEvent | { t: string; [k: string]: unknown }) => {
              controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
            };

            // Snapshot de quién está en la SALA (no en el workspace). Sin esto, quien
            // llega ve "1 conectado" hasta que alguien más entre o salga.
            send({
              t: "event:presence",
              channelId: channel.id,
              count: bus.eventPeople(ns, channel.id).length + 1,
            });

            unsub = bus.addEventClient(
              ns,
              channel.id,
              viewer.sub,
              viewer.name,
              (ev) => {
                try {
                  send(ev);
                } catch {
                  /* controller cerrado — cancel() limpia */
                }
              },
              visibleParaInvitado
            );

            desregistrar = alApagar(() => {
              if (heartbeat) clearInterval(heartbeat);
              unsub();
              try {
                controller.close();
              } catch {
                /* ya cerrado */
              }
            });

            // ⚠️ Igual que en `api.stream.ts`: si el enqueue falla, la conexión está
            // MUERTA y `cancel()` ya no va a llegar (un navegador cerrado de golpe no
            // lo dispara). Tragarse el error deja al cliente registrado para siempre y
            // el contador de la sala diciendo que hay gente que se fue hace horas.
            heartbeat = setInterval(() => {
              try {
                controller.enqueue(enc.encode(`: ping\n\n`));
              } catch {
                if (heartbeat) clearInterval(heartbeat);
                unsub();
                desregistrar();
              }
            }, 25_000);
          },
          cancel() {
            if (heartbeat) clearInterval(heartbeat);
            unsub();
            desregistrar();
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      },
    },
  },
});
