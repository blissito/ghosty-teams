import { createFileRoute } from "@tanstack/react-router";
import { alApagar } from "../server/shutdown.server";
import type { RtEvent } from "../server/bus.server";

// ── Endpoint SSE (realtime in-VM) ───────────────────────────────────────────
// Server route puro (sin component): mantiene un stream text/event-stream por
// pestaña. Autentica con gc_session y suscribe la conexión a TODOS los rooms
// visibles + su canal de usuario + presencia, así el cliente no reconecta al
// cambiar de room. La durabilidad la garantiza libSQL + getMessagesSince (catch-up).
export const Route = createFileRoute("/api/stream")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
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
        // Zona horaria del navegador (ver useLiveStream). Se escribe SOLO si cambió —
        // este endpoint se abre en cada pestaña y no vale un UPDATE por reconexión.
        try {
          const tz = new URL(request.url).searchParams.get("tz") ?? "";
          if (tz && /^[A-Za-z_+-]+\/[A-Za-z_+\-\/0-9]+$/.test(tz)) {
            const { dbq } = await import("../dbq.server");
            await dbq("UPDATE gc_users SET tz=? WHERE sub=? AND COALESCE(tz,'') <> ?", [tz, user.sub, tz]);
          }
        } catch { /* la columna puede no existir en un tenant sin migrar aún */ }

        const channels = await db.listChannels(user.sub, !!user.isOwner);
        const subChannels = [
          ...channels.map((c) => bus.ch.room(ns, c.id)),
          bus.ch.user(ns, user.sub),
          bus.ch.presence(ns),
        ];

        const enc = new TextEncoder();
        let unsub = () => {};
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        // Baja del registro de apagado. Un SSE abierto retiene el proceso: sin esto el
        // deploy esperaba 90s y acababa en SIGKILL, con el servicio caído todo ese rato.
        let desregistrar = () => {};

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (ev: RtEvent | { t: string; [k: string]: unknown }) => {
              controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
            };
            // Snapshot de presencia para el recién llegado (SOLO de su tenant).
            send({ t: "presence:init", online: bus.onlinePeople(ns) });
            // La baja es de UN SOLO uso: la dispara `cancel()` o el heartbeat muerto, y
            // llamarla dos veces descontaría dos conexiones de la misma pestaña (presencia
            // en negativo, o sea alguien conectado que deja de aparecer).
            const unsubscribeClient = bus.addClient(ns, user.sub, user.name, subChannels, (ev) => {
              try {
                send(ev);
              } catch {
                /* controller cerrado — cancel() limpia */
              }
            });
            let unsubscribed = false;
            unsub = () => {
              if (unsubscribed) return;
              unsubscribed = true;
              unsubscribeClient();
            };
            // Al apagar, esta conexión se cierra sola: el cliente reconecta con backoff
            // (useLiveStream), así que cerrarla no le cuesta nada y libera el proceso.
            desregistrar = alApagar(() => {
              if (heartbeat) clearInterval(heartbeat);
              unsub();
              try {
                controller.close();
              } catch {
                /* ya cerrado */
              }
            });
            // Heartbeat (comentario SSE) para mantener viva la conexión a través del proxy.
            // ⚠️ Si el enqueue falla, la conexión está MUERTA y `cancel()` ya no va a
            // llegar (el navegador que se cerró de golpe no lo dispara). Tragarse el
            // error dejaba al client registrado para siempre: presencia fantasma —
            // "3 en línea" con una sola persona conectada. Aquí se da de baja a mano.
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
            // Que el ingress (DNAT L4 / futuro L7) no bufferee el stream.
            "X-Accel-Buffering": "no",
          },
        });
      },
    },
  },
});
