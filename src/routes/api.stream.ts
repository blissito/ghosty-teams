import { createFileRoute } from "@tanstack/react-router";
import type { RtEvent } from "../server/bus.server";

// ── Endpoint SSE (realtime in-VM) ───────────────────────────────────────────
// Server route puro (sin component): mantiene un stream text/event-stream por
// pestaña. Autentica con gc_session y suscribe la conexión a TODOS los rooms
// visibles + su canal de usuario + presencia, así el cliente no reconecta al
// cambiar de room. La durabilidad la garantiza libSQL + getMessagesSince (catch-up).
export const Route = createFileRoute("/api/stream")({
  server: {
    handlers: {
      GET: async () => {
        const { useSession } = await import("@tanstack/react-start/server");
        const { sessionConfig } = await import("../server/session.server");
        const s = await useSession<{
          user?: { sub: string; name: string; isOwner: boolean };
        }>(sessionConfig());
        const user = s.data.user;
        if (!user) return new Response("unauthorized", { status: 401 });

        const db = await import("../db.server");
        const bus = await import("../server/bus.server");
        const { currentNamespace } = await import("../server/tenant.server");
        // Tenant del que sale esta conexión: TODOS los canales van namespaced por
        // `ns` para no cruzar realtime entre workspaces (caja multitenant).
        const ns = await currentNamespace();
        const channels = await db.listChannels(user.sub, !!user.isOwner);
        const subChannels = [
          ...channels.map((c) => bus.ch.room(ns, c.id)),
          bus.ch.user(ns, user.sub),
          bus.ch.presence(ns),
        ];

        const enc = new TextEncoder();
        let unsub = () => {};
        let heartbeat: ReturnType<typeof setInterval> | undefined;

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (ev: RtEvent | { t: string; [k: string]: unknown }) => {
              controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
            };
            // Snapshot de presencia para el recién llegado (SOLO de su tenant).
            send({ t: "presence:init", online: bus.onlineUsers(ns) });
            unsub = bus.addClient(ns, user.sub, user.name, subChannels, (ev) => {
              try {
                send(ev);
              } catch {
                /* controller cerrado — cancel() limpia */
              }
            });
            // Heartbeat (comentario SSE) para mantener viva la conexión a través del proxy.
            heartbeat = setInterval(() => {
              try {
                controller.enqueue(enc.encode(`: ping\n\n`));
              } catch {
                /* cerrado */
              }
            }, 25_000);
          },
          cancel() {
            if (heartbeat) clearInterval(heartbeat);
            unsub();
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            // Que el ingress (DNAT L4 / futuro L7) no bufferee el stream.
            "X-Accel-Buffering": "no",
          },
        });
      },
    },
  },
});
