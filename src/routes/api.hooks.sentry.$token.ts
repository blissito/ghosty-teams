import { createFileRoute } from "@tanstack/react-router";

// POST /api/hooks/sentry/<token> → una alerta de Sentry se convierte en un mensaje del canal.
//
// Es el PRIMER camino entrante del producto: hasta ahora todo salía de nosotros hacia el
// proveedor. Lo configura el agente desde el chat con `sentry_alerts_enable`, que registra
// esta URL en el proyecto de Sentry del usuario — el cliente no toca nada allá.
//
// ⚠️ SENTRY NO FIRMA ESTO. El webhook legacy manda un POST pelado: ni `sentry-hook-signature`
// ni secreto compartido (`LegacyWebhookClient` en getsentry/sentry). O sea que **el token de
// la URL es la única credencial**, y de ahí salen casi todas las decisiones de abajo:
// token malo → 404 sin explicar nada, tope de escritura por canal, idempotencia por evento,
// y CERO confianza en el contenido del cuerpo (sólo se pinta como texto, no se usa para
// decidir a dónde va).
//
// Multi-tenant: el namespace viaja FIRMADO en el token y se entra con `withNamespace`. Sin
// eso `currentNamespace()` caería a `SQLD_NAMESPACE`, o sea al tenant equivocado — que es
// exactamente el bug que tenía el webhook de EasyBits y ya se pagó una vez.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

// Tope por canal: 20 alertas por minuto. Un despliegue roto genera miles de eventos y sin
// esto la conversación queda enterrada. Al pasarse se sigue contando pero NO se escribe, y
// el primer mensaje de la siguiente ventana dice cuántas se omitieron.
const WINDOW_S = 60;
const MAX_PER_WINDOW = 20;

export const Route = createFileRoute("/api/hooks/sentry/$token")({
  server: {
    handlers: {
      POST: async ({ params, request }: { params: { token: string }; request: Request }) => {
        const { verifyHookToken } = await import("../server/hooks/token.server");
        const ref = verifyHookToken(params.token);
        // 404 y no 401: a quien está probando tokens no hay por qué confirmarle que
        // alguno existe.
        if (!ref) return json({ ok: false }, 404);

        let payload: any;
        try {
          payload = await request.json();
        } catch {
          return json({ ok: false, error: "cuerpo inválido" }, 400);
        }

        const { withNamespace } = await import("../server/tenant.server");
        return withNamespace(ref.ns, async () => {
          const { ensureSchema } = await import("../server/schema.server");
          await ensureSchema();
          const { dbq } = await import("../dbq.server");

          // ── Idempotencia ──────────────────────────────────────────────────
          // Sentry reintenta. El `event_id` es del proveedor; si no viniera, se cae al id
          // del grupo, que al menos evita repetir la MISMA alerta dos veces seguidas.
          const eventId = String(
            payload?.event?.event_id ?? payload?.event?.id ?? payload?.id ?? ""
          ).slice(0, 100);
          if (eventId) {
            const dup = await dbq(
              `INSERT INTO gt_hook_seen (event_id, at) VALUES (?, unixepoch())
               ON CONFLICT(event_id) DO NOTHING RETURNING event_id`,
              [eventId]
            ).catch(() => null);
            // `null` = la consulta falló: se deja pasar. Perder una alerta es peor que
            // duplicarla, y el modo de falla de la tabla no puede ser el silencio.
            if (dup && dup.length === 0) return json({ ok: true, duplicate: true });
          }

          // ── Tope por canal ────────────────────────────────────────────────
          const windowStart = Math.floor(Date.now() / 1000 / WINDOW_S) * WINDOW_S;
          let n = 1;
          try {
            const r = await dbq(
              `INSERT INTO gt_hook_rate (channel_id, window_start, count) VALUES (?, ?, 1)
               ON CONFLICT(channel_id, window_start) DO UPDATE SET count = count + 1
               RETURNING count`,
              [ref.channelId, windowStart]
            );
            n = Number(r[0]?.count ?? 1);
            if (n === 1) {
              await dbq(`DELETE FROM gt_hook_rate WHERE window_start < ?`, [windowStart - 3600]);
              await dbq(`DELETE FROM gt_hook_seen WHERE at < unixepoch() - 86400`);
            }
          } catch {
            // Igual que arriba: si el contador falla, se entrega.
          }
          if (n > MAX_PER_WINDOW) {
            // Un solo aviso al cruzar el umbral, no uno por evento.
            if (n === MAX_PER_WINDOW + 1) {
              await publicar(
                ref,
                `⚠️ **Demasiadas alertas de Sentry** — más de ${MAX_PER_WINDOW} en un minuto. ` +
                  `Dejo de publicarlas para no enterrar el canal; siguen en Sentry y puedes ` +
                  `pedírmelas con \`sentry_list_issues\`.`
              );
            }
            return json({ ok: true, throttled: true });
          }

          await publicar(ref, formatear(payload));
          return json({ ok: true });
        });
      },
    },
  },
});

/**
 * El payload del webhook legacy es PRIVADO del lado de Sentry (endpoints marcados
 * `ApiPublishStatus.PRIVATE`), así que puede cambiar sin aviso: todo se lee con
 * fallback y nada se asume presente. Lo peor que puede pasar es un mensaje escueto,
 * nunca una excepción que pierda la alerta.
 */
function formatear(p: any): string {
  const nivel = String(p?.level ?? p?.event?.level ?? "error").toLowerCase();
  const icono = nivel === "warning" ? "⚠️" : nivel === "info" ? "ℹ️" : "🔴";
  const titulo = String(p?.event?.title ?? p?.message ?? p?.culprit ?? "Error en Sentry").slice(0, 300);
  const proyecto = String(p?.project_name ?? p?.project ?? "").slice(0, 100);
  const culprit = String(p?.culprit ?? "").slice(0, 200);
  const url = typeof p?.url === "string" ? p.url : typeof p?.event?.web_url === "string" ? p.event.web_url : "";
  const regla = Array.isArray(p?.triggering_rules) ? p.triggering_rules.filter(Boolean).join(", ") : "";

  const lineas = [`${icono} **${titulo}**`];
  const meta = [proyecto && `proyecto \`${proyecto}\``, nivel && `nivel \`${nivel}\``]
    .filter(Boolean)
    .join(" · ");
  if (meta) lineas.push(meta);
  if (culprit) lineas.push(`en \`${culprit}\``);
  if (regla) lineas.push(`_regla: ${regla}_`);
  if (url) lineas.push(`[Ver en Sentry](${url})`);
  return lineas.join("\n");
}

/**
 * Publica en el canal congelado en el token, con la identidad del agente que configuró la
 * alerta.
 *
 * ⚠️ NO llama a `notify()` a propósito. Crear un mensaje no manda push por sí solo, y una
 * racha de errores despertaría el teléfono de todo el equipo. Si algún día se quiere avisar,
 * va con destinatarios EXPLÍCITOS (quien configuró la alerta), nunca el roster del canal.
 */
async function publicar(
  ref: { ns: string; channelId: number; topic: string; handle: string; name: string; avatar: string },
  cuerpo: string
): Promise<void> {
  try {
    const db = await import("../db.server");
    const bus = await import("../server/bus.server");
    // `postAgent` y no `createMessage`: el segundo pone `mentions_ghosty=1` cuando recibe un
    // agentHandle, o sea que DISPARARÍA al agente con cada alerta. Aquí el agente es el
    // autor, no el destinatario.
    const { id } = await db.postAgent(
      ref.channelId,
      null,
      cuerpo,
      "msg",
      ref.handle,
      ref.name,
      ref.topic,
      ref.avatar
    );
    const msg = await db.getMessage(id);
    if (msg) bus.publish(bus.ch.room(ref.ns, ref.channelId), { t: "message:new", msg });
  } catch (e) {
    console.error("[hook sentry] no pude publicar", e);
  }
}
