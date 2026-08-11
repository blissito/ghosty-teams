import { createFileRoute } from "@tanstack/react-router";

// POST /api/hooks/whatsapp/<token>/message → un mensaje de WhatsApp aparece en su room.
//
// Formmy es el BSP: recibe el webhook de Meta, persiste su lado, y forwardea aquí lo que
// pasa por el número. El `/message` del final lo pega ÉL (guarda
// `Integration.externalAgentUrl` = todo menos ese sufijo), así que la ruta tiene que vivir
// exactamente en este path. Ver `~/formmy_rrv7/server/channels/handler.ts`.
//
// Molde: `api.hooks.sentry.$token.ts`, que ya resolvió el ns firmado y la idempotencia.
// ⚠️ Diferencia importante con Sentry: ESTO SÍ VIENE AUTENTICADO. El Bearer es el
// `channelSecret` que emitimos al conectar, así que el token de la URL no carga solo.
//
// ⚠️ Y la restricción de tiempo: el forward de Formmy corre DENTRO del webhook de Meta,
// con reintentos cortos y sin cola de fondo a propósito (reintentar en background dejaría
// que el mensaje 2 rebase al 1). O sea que aquí se contesta 200 PRONTO: lo que tarde —hoy
// sólo bajar la media— va fire-and-forget después.
import crypto from "node:crypto";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

/** Etiqueta de un mensaje que sólo trae media, para que la burbuja no quede vacía. */
const MEDIA_LABEL: Record<string, string> = {
  image: "📷 Imagen",
  video: "🎬 Video",
  document: "📄 Documento",
  audio: "🎤 Audio",
  sticker: "🩹 Sticker",
};

type WaForward = {
  sender?: string;
  sender_name?: string;
  content?: string;
  message_id?: string;
  integration_id?: string;
  is_from_me?: boolean;
  manual_mode?: boolean;
  media?: {
    type?: string;
    media_id?: string;
    url?: string | null;
    mime_type?: string;
    caption?: string;
    filename?: string;
  };
  location?: { latitude?: number; longitude?: number; name?: string };
};

export const Route = createFileRoute("/api/hooks/whatsapp/$token/message")({
  server: {
    handlers: {
      POST: async ({ params, request }: { params: { token: string }; request: Request }) => {
        const { verifyWaToken } = await import("../server/whatsapp/token.server");
        const ref = verifyWaToken(params.token);
        // 404 y no 401: a quien prueba tokens no hay por qué confirmarle que alguno existe.
        if (!ref) return json({ ok: false }, 404);

        // Bearer == channelSecret (== `Integration.externalAgentSecret` de Formmy).
        const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
        const a = Buffer.from(bearer);
        const b = Buffer.from(ref.channelSecret);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return json({ ok: false }, 401);

        let payload: WaForward;
        try {
          payload = (await request.json()) as WaForward;
        } catch {
          return json({ ok: false, error: "cuerpo inválido" }, 400);
        }

        const phone = String(payload.sender ?? "").replace(/[^\d]/g, "");
        const integrationId = String(payload.integration_id ?? "");
        if (!phone || !integrationId) return json({ ok: true, skipped: "sin sender/integration_id" });

        const { withNamespace } = await import("../server/tenant.server");
        return withNamespace(ref.ns, async () => {
          const { ensureSchema } = await import("../server/schema.server");
          await ensureSchema();
          const { dbq } = await import("../dbq.server");
          const db = await import("../db.server");
          const bus = await import("../server/bus.server");

          // ── Idempotencia ────────────────────────────────────────────────────────
          // Meta reintenta y Formmy le pasa el reintento. La clave es el `message_id` de
          // Meta, que ya viene en el forward — no un hash del cuerpo: el mismo mensaje
          // puede llegar con metadatos distintos.
          //
          // Si la consulta revienta se ENTREGA: perder un mensaje de un cliente es peor
          // que duplicarlo, y el modo de falla de la tabla no puede ser el silencio.
          const eventId = String(payload.message_id ?? "").slice(0, 100);
          if (eventId) {
            const dup = await dbq(
              `INSERT INTO gt_hook_seen (event_id, at) VALUES (?, unixepoch())
               ON CONFLICT(event_id) DO NOTHING RETURNING event_id`,
              [`wa:${eventId}`],
            ).catch(() => null);
            if (dup && dup.length === 0) return json({ ok: true, duplicate: true });
          }

          const { getWaChannel, resolveContactThread } = await import(
            "../server/whatsapp/channels.server"
          );
          const chan = await getWaChannel(integrationId);
          // Sin fila = número que ya no está conectado de nuestro lado. Ack para que no
          // reintente, y no se escribe nada.
          if (!chan) return json({ ok: true, orphaned: true });

          // ⚠️ El room manda el TOKEN, no la fila: el token es lo que Formmy tiene y lo que
          // firmamos. Si discrepan (se reconectó a otro room), gana el de la fila, que es lo
          // último que eligió el owner.
          const roomId = chan.roomId || ref.roomId;

          const contactName = String(payload.sender_name ?? "").slice(0, 80);
          const { threadId, created } = await resolveContactThread({
            integrationId,
            roomId,
            phone,
            contactName,
            topic: ref.topic,
          });
          if (created) {
            const rootMsg = await db.getMessage(threadId);
            if (rootMsg) bus.publish(bus.ch.room(ref.ns, roomId), { t: "message:new", msg: rootMsg });
          }

          // ── El mensaje ──────────────────────────────────────────────────────────
          // `is_from_me` = el dueño contestó desde SU teléfono. Se escribe igual, porque un
          // room que enseña sólo un lado de la conversación no sirve para atender a nadie;
          // lo que NO hace nunca es despertar al agente.
          const mine = payload.is_from_me === true;
          const media = payload.media;
          const loc = payload.location;
          let body = String(payload.content ?? "").trim();
          if (!body && media) body = media.caption?.trim() || MEDIA_LABEL[media.type ?? ""] || "📎 Adjunto";
          if (!body && loc?.latitude != null) {
            body = `📍 Ubicación: ${loc.name ? `${loc.name} — ` : ""}${loc.latitude}, ${loc.longitude}`;
          }
          if (!body) return json({ ok: true, skipped: "sin contenido" });

          const { id: msgId } = await db.createMessage({
            channelId: roomId,
            parentId: threadId,
            sender: mine ? "Tú (WhatsApp)" : contactName || `+${phone}`,
            senderSub: null, // ni el contacto ni el número son members: no ocupan asiento
            avatar: "",
            body,
            topic: ref.topic,
          });
          const msg = await db.getMessage(msgId);
          if (msg) bus.publish(bus.ch.room(ref.ns, roomId), { t: "message:new", msg });

          // ── Media: después del ack ──────────────────────────────────────────────
          // `media.url` es el PROXY autenticado de Formmy (streaming directo desde Meta),
          // no la URL firmada de Meta ni base64. Necesita el mismo Bearer del canal.
          //
          // Va fire-and-forget porque bajar un archivo no cabe en el presupuesto del
          // webhook de Meta. El mensaje ya está en pantalla; el adjunto aterriza encima.
          if (media?.url) {
            void ingestMedia({
              ns: ref.ns,
              roomId,
              threadId,
              msgId,
              url: media.url,
              secret: chan.channelSecret,
              mime: media.mime_type || "application/octet-stream",
              name: media.filename || `wa-${media.type ?? "file"}`,
            }).catch((e) => console.error("[wa] media ingest failed", String(e).slice(0, 200)));
          }

          return json({ ok: true, messageId: msgId, mine });
        });
      },
    },
  },
});

/** Baja el adjunto del proxy de Formmy a nuestro storage y lo cuelga del mensaje. */
async function ingestMedia(a: {
  ns: string;
  roomId: number;
  threadId: number;
  msgId: number;
  url: string;
  secret: string;
  mime: string;
  name: string;
}): Promise<void> {
  const res = await fetch(a.url, { headers: { Authorization: `Bearer ${a.secret}` } });
  if (!res.ok) throw new Error(`proxy ${res.status}`);
  const blob = await res.blob();
  const { withNamespace } = await import("../server/tenant.server");
  await withNamespace(a.ns, async () => {
    const storage = await import("../server/storage.server");
    const put = await storage.put({ blob, contentType: a.mime, fileName: a.name });
    const db = await import("../db.server");
    await db.createAttachments(a.msgId, [
      { fileId: put.key, mime: put.mime, size: put.size, name: put.name },
    ]);
    // `refresh` y no `message:new`: el mensaje ya se publicó, y republicarlo lo duplicaría
    // en el cliente. El hilo se vuelve a leer y aparece el adjunto.
    const bus = await import("../server/bus.server");
    bus.publish(bus.ch.room(a.ns, a.roomId), { t: "refresh", channelId: a.roomId, parentId: a.threadId });
  });
}
