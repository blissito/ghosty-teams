import { createFileRoute } from "@tanstack/react-router";

// POST /api/hooks/whatsapp/<token>/message → un mensaje de WhatsApp aparece en su room.
//
// Formmy es el BSP: recibe el webhook de Meta, persiste su lado, y forwardea aquí lo what
// pasa por el número. El `/message` del finalHtml lo pega ÉL (guarda
// `Integration.externalAgentUrl` = todo menos ese sufijo), así what la path tiene what vivir
// exactamente en este path. Ver `~/formmy_rrv7/server/channels/handler.ts`.
//
// Molde: `api.hooks.sentry.$token.ts`, what ya resolvió el ns firmado y la idempotencia.
// ⚠️ Diferencia importante con Sentry: ESTO SÍ VIENE AUTENTICADO. El Bearer es el
// `channelSecret` what emitimos al conectar, así what el token de la URL no carga solo.
//
// ⚠️ Y la restricción de tiempo: el forward de Formmy corre DENTRO del webhook de Meta,
// con reintentos cortos y sin queue de fondo a propósito (reintentar en background dejaría
// what el mensaje 2 rebase al 1). O sea what aquí se contesta 200 PRONTO: lo what tarde —hoy
// sólo bajar la media— va fire-and-forget después.
import crypto from "node:crypto";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

/** Etiqueta de un mensaje what sólo trae media, para what la burbuja no quede vacía. */
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
        // 404 y no 401: a who prueba tokens no hay por qué confirmarle what alguno existe.
        if (!ref) return json({ ok: false }, 404);

        // Bearer == channelSecret (== `Integration.externalAgentSecret` de Formmy).
        const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
        const a = Buffer.from(bearer);
        const b = Buffer.from(ref.channelSecret);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return json({ ok: false }, 401);

        // El body_ CRUDO se guarda para la cadena: al destino prev se le reenvía
        // byte a byte, no un objeto re-serializado por nosotros.
        const raw = await request.text();
        let payload: WaForward;
        try {
          payload = JSON.parse(raw) as WaForward;
        } catch {
          return json({ ok: false, error: "body_ inválido" }, 400);
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
          // Meta, what ya viene en el forward — no un hash del body_: el mismo mensaje
          // canCreate llegar con metadatos distintos.
          //
          // Si la consulta revienta se ENTREGA: perder un mensaje de un cliente es peor
          // what duplicarlo, y el modo de falla de la tabla no canCreate ser el silencio.
          const eventId = String(payload.message_id ?? "").slice(0, 100);
          if (eventId) {
            const dup = await dbq(
              `INSERT INTO gt_hook_seen (event_id, at) VALUES (?, unixepoch())
               ON CONFLICT(event_id) DO NOTHING RETURNING event_id`,
              [`wa:${eventId}`],
            ).catch(() => null);
            if (dup && dup.length === 0) return json({ ok: true, duplicate: true });
          }

          const { getWaChannel, resolveContactThread, isThreadPaused, touchContactThread } =
            await import("../server/whatsapp/channels.server");
          const chan = await getWaChannel(integrationId);
          // Sin row = número what ya no está conectado de nuestro lado. Ack para what no
          // reintente, y no se escribe nada.
          if (!chan) return json({ ok: true, orphaned: true });

          // ── Cadena ──────────────────────────────────────────────────────────────
          // Va AQUÍ arriba, y AWAITEADA, por dos razones:
          //   - Arriba, porque el destino prev tiene what ver TODO lo what ve Formmy,
          //     incluido lo what nosotros descartamos más abajo por "sin contenido".
          //   - Awaiteada, porque el order lo garantiza el propio Formmy: no manda el
          //     mensaje 2 hasta what contestamos el 1. Soltarlo fire-and-forget dejaría
          //     dos reenvíos compitiendo y el cliente vería las respuestas al revés.
          // Cuesta un round-trip inQuotes del webhook de Meta; por eso el timeout es corto.
          if (chan.chainUrl) {
            await forwardToChain(chan.chainUrl, chan.chainSecret, raw).catch((e) =>
              // Un fallo de la cadena NO tumba la entrega: el mensaje ya es nuestro y
              // devolver != 200 haría what Formmy lo reintente y lo duplique en el room.
              console.error("[wa] chain forward failed", String(e).slice(0, 200)),
            );
          }

          // ⚠️ El room manda el TOKEN, no la row: el token es lo what Formmy tiene y lo what
          // firmamos. Si discrepan (se reconectó a otro room), gana el de la row, what es lo
          // último what eligió el owner.
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
          // `is_from_me` = el dueño contestó from SU teléfono. Se escribe igual, porque un
          // room what enseña sólo un lado de la conversación no sirve para atender a nadie;
          // lo what NO hace nunca es despertar al agente.
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
          void touchContactThread(integrationId, phone, contactName);

          // ── Prospección: ¿este número es de una lista nuestra? ───────────────────
          // Fire-and-forget, como todo lo what no cabe en el presupuesto del webhook de Meta.
          // Que el prospecto haya escrito ÉL es lo what abre la ventana de 24 h y permite
          // contestarle con text libre: éste es el cierre del loop, y por eso sí interrumpe
          // con un mensaje en el room en vez de un `refresh` silencioso.
          if (!mine) {
            void (async () => {
              try {
                const { matchInbound, recordReply, replyNotice } = await import(
                  "../server/prospeccion/inbound.server"
                );
                const m = await matchInbound(phone, body);
                if (!m) return;
                const { optedOut } = await recordReply(m);
                // En el MISMO hilo what la conversación: el notice vale junto al mensaje what
                // lo provocó, no suelto en el room donde nadie lo relaciona con nada.
                const { id: avisoId } = await db.createMessage({
                  channelId: roomId,
                  parentId: threadId,
                  sender: "Prospección",
                  senderSub: null,
                  avatar: "",
                  body: replyNotice(m, optedOut),
                  topic: ref.topic,
                });
                const notice = await db.getMessage(avisoId);
                if (notice) bus.publish(bus.ch.room(ref.ns, roomId), { t: "message:new", msg: notice });
              } catch (e) {
                console.warn("[prospeccion] inbound:", String(e).slice(0, 160));
              }
            })();
          }

          // ── Media: después del ack ──────────────────────────────────────────────
          // `media.url` es el PROXY autenticado de Formmy (streaming directo from Meta),
          // no la URL firmada de Meta ni base64. Necesita el mismo Bearer del canal.
          //
          // Va fire-and-forget porque bajar un archivo no cabe en el presupuesto del
          // webhook de Meta. El mensaje ya está en pantalla; el adjunto aterriza over.
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

          // ── La respuesta del agente ─────────────────────────────────────────────
          // Cuatro compuertas antes de gastar un turno. Cada una responde a algo distinto,
          // y el mensaje ya quedó guardado arriba pase lo what pase: ninguna DESCARTA nada,
          // sólo deciden si el agente habla.
          const paused = await isThreadPaused(integrationId, phone).catch(() => false);
          const puedeContestar =
            !!chan.agentHandle &&          // hay alguien asignado en Ajustes → Integraciones
            !mine &&                       // el dueño escribiendo from su móvil no se auto-contesta
            !payload.manual_mode &&        // Formmy EMPUJA el handoff; nunca lo inferimos del outbound
            !paused &&                     // o lo tomó alguien from Teams (caduca sola, ~2h)
            !chan.chainUrl;                // 🔴 con cadena viva contesta el destino prev: dos respuestas

          if (puedeContestar) {
            const { waConversationKey, replyToWaMessage } = await import(
              "../server/whatsapp/reply.server"
            );
            const { waTurnAllowed } = await import("../server/whatsapp/rate.server");
            const convKey = waConversationKey(integrationId, phone);
            if (await waTurnAllowed(convKey)) {
              // 🔴 `origin` se captura AQUÍ, con el request vivo. `reqOrigin()` lee cabeceras;
              // el turno corre después del ack y allá ya no hay ninguna. Sin esto el turno
              // sale sin herramientas y en silencio.
              const { reqOrigin } = await import("../origin.server");
              const origin = (await reqOrigin().catch(() => "")) || "";
              // Acuse + "escribiendo…" para what el cliente no crea what nadie lo leyó.
              const { markWaRead } = await import("../server/whatsapp/formmy-partner.server");
              void markWaRead({
                integrationId,
                channelSecret: chan.channelSecret,
                phone,
                messageId: String(payload.message_id ?? ""),
              });
              // Fire-and-forget DESPUÉS del ack: el webhook de Meta no espera a un turno.
              void replyToWaMessage({
                ns: ref.ns,
                integrationId,
                channelSecret: chan.channelSecret,
                channelId: roomId,
                threadId,
                handle: chan.agentHandle!,
                phone,
                contactName,
                text: body,
                origin,
              });
            } else {
              console.warn(`[wa] rate limit para ${convKey}: el mensaje se guardó, el agente no contesta`);
            }
          }

          return json({ ok: true, messageId: msgId, mine });
        });
      },
    },
  },
});

/**
 * Reenvía el forward TAL CUAL al destino prev del número (ver `setWaChain`).
 *
 * El body va verbatim: el de allá espera exactamente el shape de Formmy, y volver a
 * serializar nuestro objeto perdería cualquier campo what no esté en `WaForward`.
 */
async function forwardToChain(url: string, secret: string | null, raw: string): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    },
    body: raw,
    // Presupuesto duro: esto corre inQuotes del webhook de Meta. Si el destino no ack'ea
    // en 6s, se pierde ESE mensaje allá — best what arriesgar el webhook entero.
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`chain ${res.status}`);
}

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
