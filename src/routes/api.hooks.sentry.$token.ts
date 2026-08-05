import { formatAlert } from "../lib/sentry-alert";
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

          // ── ¿Sigue viva la conexión que lo sostiene? ───────────────────────
          // Red de seguridad para los huérfanos: el token del hook NO caduca (la URL vive
          // del lado de Sentry y tiene que seguir sirviendo meses después), así que si
          // alguien desconectó y la limpieza falló, esto seguiría publicando para siempre.
          //
          // Tres reglas que impone el resto del archivo:
          //  · `ownerSub` vacío = token de antes de que existiera el campo → DEJAR PASAR.
          //  · si la consulta revienta, se ENTREGA: perder una alerta es peor que duplicarla.
          //  · esto es una condición de VIDA, no autorización — el token sigue siendo la
          //    credencial; aquí sólo se comprueba que la conexión no se haya ido.
          if (ref.ownerSub) {
            try {
              const { listAvailableProviders } = await import("../server/connectors/store.server");
              const vivos = await listAvailableProviders(ref.ownerSub);
              if (!vivos.has("sentry")) return json({ ok: true, orphaned: true });
            } catch {
              /* fail-open a propósito */
            }
          }

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

          // Enriquecer con el issue: el webhook no trae conteos ni shortId. Es opcional a
          // propósito — `issueForAlert` se traga cualquier fallo y devuelve null.
          const issueId = String(payload?.id ?? payload?.event?.issue_id ?? payload?.event?.groupID ?? "").slice(0, 100);
          let issue: Record<string, any> | null = null;
          if (ref.ownerSub && issueId) {
            const { issueForAlert } = await import("../server/connectors/sentry.server");
            issue = await issueForAlert(ref.ownerSub, issueId);
          }

          const alertId = await publicar(ref, formatAlert(payload, issue, ref.handle));

          // ── Enriquecimiento automático ────────────────────────────────────
          // El agente investiga y deja el resumen EN EL HILO de la alerta. Ver
          // `sentry-enrich.server.ts` para el porqué (y para el umbral, que no es opcional).
          //
          // ⚠️ NO se espera: un turno de agente tarda decenas de segundos y Sentry
          // REINTENTA el webhook si tardamos en contestar. Contestamos ya y el turno sigue
          // por su cuenta, dentro de su propio `withNamespace` — el contexto del request se
          // desmonta al responder, así que sin ese envoltorio la investigación escribiría
          // en el tenant equivocado.
          const { worthEnriching, enrichAlertInThread } = await import("../server/sentry-enrich.server");
          if (alertId && ref.ownerSub && worthEnriching(issue)) {
            // ⚠️ El origin se lee AQUÍ, con el request todavía vivo. `reqOrigin()` sale de
            // las cabeceras, y el turno corre después de contestar: allá dentro ya no hay
            // request. Sin él, el minteo del tool-token cae a un catch best-effort y el
            // agente investiga SIN herramientas — contesta "no tengo acceso a Sentry" con
            // la integración perfectamente conectada, y sin un solo error en el log.
            const { reqOrigin } = await import("../origin.server");
            const origin = await reqOrigin().catch(() => "");
            void withNamespace(ref.ns, () =>
              enrichAlertInThread({
                ns: ref.ns,
                channelId: ref.channelId,
                alertMessageId: alertId,
                handle: ref.handle,
                ownerSub: ref.ownerSub,
                issue: issue!,
                origin,
              })
            );
          }
          return json({ ok: true });
        });
      },
    },
  },
});


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
): Promise<number | null> {
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
    return id;
  } catch (e) {
    console.error("[hook sentry] no pude publicar", e);
    return null;
  }
}
