// Tools de la Software Factory. SÓLO existen en un espacio que la tiene instalada
// (`gt_installed_apps`): sin la fila, esto devuelve [] y ni se anuncian ni se ejecutan.
// Decidido 2026-09-24 — la fábrica se INSTALA por espacio y sus tools aparecen con ella.
//
// Hoy: el webhook genérico de alertas de monitoreo. Las `factory_*` (corrida, estafeta,
// tarjeta de plan) se suman aquí mismo.
import type { ConnectorTool } from "../connectors/impl";
import type { ToolDest } from "../connectors/tool-token.server";
import { isInstalled } from "./installed.server";

export async function factoryTools(_sub: string, dest: ToolDest | null): Promise<ConnectorTool[]> {
  if (!(await isInstalled("factory").catch(() => false))) return [];
  const { alertWebhookTools } = await import("../hooks/generic-alert.server");
  return [...alertWebhookTools(dest)];
}

/** Bloque de contexto del turno. null si la fábrica no está instalada. */
export async function factoryContext(_dest: ToolDest | null): Promise<string | null> {
  if (!(await isInstalled("factory").catch(() => false))) return null;
  return (
    "[SOFTWARE FACTORY instalada en este espacio. ALERTAS DE MONITOREO: si piden conectar su " +
    "monitoreo (Datadog, Grafana, Better Stack, UptimeRobot o cualquier herramienta con webhooks) " +
    "o que les avisen cuando algo se caiga, usa `alert_webhook_create` { name } en el canal donde " +
    "deben caer las alertas. Devuelve una URL SECRETA y cómo pegarla en cada herramienta: dásela " +
    "sólo a quien la pidió. Cada alerta disparada llega al canal y se investiga en su hilo. También " +
    "`alert_webhook_list` y `alert_webhook_delete` { name }. Para Sentry usa su conector.]"
  );
}
