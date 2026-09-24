import { createFileRoute } from "@tanstack/react-router";

// POST /api/hooks/alert/<token> → webhook GENÉRICO de alertas de monitoreo.
//
// Cualquier herramienta que sepa mandar un webhook (Datadog, Grafana/Alertmanager, Better
// Stack, UptimeRobot, un script propio…) cae aquí. La alerta se pinta en el canal congelado
// en el token y, si es un problema NUEVO del día y está disparada, el agente la investiga en
// su hilo (real o ruido, causa, PR en borrador). Las recuperaciones sólo se pintan.
//
// Mismas reglas que el de Sentry (`api.hooks.sentry.$token.ts`), por las mismas razones: el
// token de la URL es la única credencial (404 sin explicar), idempotencia por entrega, tope
// de 20 por minuto por canal, cero confianza en el cuerpo, y el turno NUNCA se espera — los
// proveedores reintentan si tardamos.
//
// Lo crea el agente desde el chat con `alert_webhook_create`; borrarlo
// (`alert_webhook_delete`) corta la entrega aunque el token no caduque.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export const Route = createFileRoute("/api/hooks/alert/$token")({
  server: {
    handlers: {
      POST: async ({ params, request }: { params: { token: string }; request: Request }) => {
        const { verifyHookToken } = await import("../server/hooks/token.server");
        const ref = verifyHookToken(params.token);
        if (!ref || !ref.hook) return json({ ok: false }, 404);

        const { parseAlertBody, normalizeAlert, formatGenericAlert } = await import("../server/hooks/alert-normalize");
        const raw = await request.text().catch(() => "");
        const body = parseAlertBody(raw);
        if (!body) return json({ ok: false, error: "cuerpo vacío o demasiado grande" }, 400);
        const alert = normalizeAlert(body);

        const { withNamespace } = await import("../server/tenant.server");
        return withNamespace(ref.ns, async () => {
          const { ensureSchema } = await import("../server/schema.server");
          await ensureSchema();
          const g = await import("../server/hooks/generic-alert.server");

          if (!(await g.hookAlive(ref))) return json({ ok: true, orphaned: true });
          if (await g.alreadySeen(alert, raw)) return json({ ok: true, duplicate: true });

          const n = await g.bumpRate(ref.channelId);
          if (n > g.RATE_MAX) {
            if (n === g.RATE_MAX + 1) {
              await g.publishAsAgent(
                ref,
                `⚠️ **Demasiadas alertas** — más de ${g.RATE_MAX} en un minuto en el webhook «${ref.hook}». ` +
                  `Dejo de publicarlas para no enterrar el canal; siguen en tu herramienta de monitoreo.`,
              );
            }
            return json({ ok: true, throttled: true });
          }

          const alertId = await g.publishAsAgent(ref, formatGenericAlert(alert, ref.hook!));

          // Sólo lo disparado se investiga; una recuperación no tiene nada que revisar.
          if (alertId && alert.status !== "resolved") {
            // ⚠️ El origin se lee AQUÍ, con el request vivo: el despertador corre después y
            // sin él el agente investigaría SIN herramientas (ver el webhook de Sentry).
            const { reqOrigin } = await import("../origin.server");
            const origin = await reqOrigin().catch(() => "");
            await g.enqueueAlertInvestigation({ ref, alert, alertMessageId: alertId, origin });
          }
          return json({ ok: true });
        });
      },
    },
  },
});
