// Entrega de una alerta del webhook GENÉRICO (`/api/hooks/alert/<token>`): la tarjeta en el
// canal y, si es un problema nuevo del día, la investigación de la fábrica en su hilo.
//
// Calcado del camino de Sentry (`routes/api.hooks.sentry.$token.ts`) —idempotencia en
// `gt_hook_seen`, tope por canal en `gt_hook_rate`, `postAgent` y no `createMessage`— y del
// triage de alertas (`alert-triage.server.ts`): el turno es un despertador con key = huella +
// día, así que un monitor que parpadea todo el día se investiga UNA vez.
import { createHash } from "node:crypto";
import { dbq } from "../../dbq.server";
import type { HookRef } from "./token.server";
import type { NormalizedAlert } from "./alert-normalize";
import type { ConnectorTool } from "../connectors/impl";
import type { ToolDest } from "../connectors/tool-token.server";

export const HOOK_PROVIDER = "webhook";

const WINDOW_S = 60;
const MAX_PER_WINDOW = 20;

/** ¿Sigue existiendo el webhook? Si la consulta falla se ENTREGA: perder una alerta es peor. */
export async function hookAlive(ref: HookRef): Promise<boolean> {
  if (!ref.hook) return true;
  try {
    const rows = await dbq(
      "SELECT 1 FROM gt_connector_hooks WHERE provider=? AND channel_id=? AND project=? LIMIT 1",
      [HOOK_PROVIDER, ref.channelId, ref.hook],
    );
    return rows.length > 0;
  } catch {
    return true;
  }
}

/**
 * true = ya se vio esta entrega (reintento del proveedor). Sin id del proveedor se usa un
 * hash del cuerpo + el minuto: evita el doble POST inmediato sin tragarse una alerta que se
 * repite de verdad más tarde.
 */
export async function alreadySeen(a: NormalizedAlert, raw: string): Promise<boolean> {
  const id = a.eventId
    ? `wh:${a.source}:${a.eventId}`.slice(0, 100)
    : `wh:${createHash("sha1").update(`${Math.floor(Date.now() / 60_000)}|${raw}`).digest("hex").slice(0, 32)}`;
  const r = await dbq(
    `INSERT INTO gt_hook_seen (event_id, at) VALUES (?, unixepoch())
     ON CONFLICT(event_id) DO NOTHING RETURNING event_id`,
    [id],
  ).catch(() => null);
  return !!r && r.length === 0;
}

/** Cuenta la entrega en la ventana del canal. Devuelve el número de esta entrega. */
export async function bumpRate(channelId: number): Promise<number> {
  const windowStart = Math.floor(Date.now() / 1000 / WINDOW_S) * WINDOW_S;
  try {
    const r = await dbq(
      `INSERT INTO gt_hook_rate (channel_id, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(channel_id, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
      [channelId, windowStart],
    );
    const n = Number(r[0]?.count ?? 1);
    if (n === 1) {
      await dbq(`DELETE FROM gt_hook_rate WHERE window_start < ?`, [windowStart - 3600]);
      await dbq(`DELETE FROM gt_hook_seen WHERE at < unixepoch() - 86400`);
    }
    return n;
  } catch {
    return 1;
  }
}
export const RATE_MAX = MAX_PER_WINDOW;

/** Publica con la identidad del agente. `postAgent`: el agente es AUTOR, no destinatario. */
export async function publishAsAgent(ref: HookRef, body: string, parentId: number | null = null): Promise<number | null> {
  try {
    const db = await import("../../db.server");
    const bus = await import("../bus.server");
    const { id } = await db.postAgent(ref.channelId, parentId, body, "msg", ref.handle, ref.name, ref.topic, ref.avatar);
    const msg = await db.getMessage(id);
    if (msg) bus.publish(bus.ch.room(ref.ns, ref.channelId), { t: "message:new", msg });
    return id;
  } catch (e) {
    console.error("[hook alert] no pude publicar", e);
    return null;
  }
}

const ENCARGO =
  "Entró esta alerta de monitoreo en el canal. Investígala y deja el resumen aquí, en su hilo:\n" +
  "1. ¿Es real o ruido? Mójate; si no estás seguro, di qué falta para estarlo.\n" +
  "2. Si es real y tienes el repo a la mano: causa probable con archivo:línea.\n" +
  "3. Si el arreglo es claro y chico, abre un PR en borrador (flujo de code-change). " +
  "Si amerita seguimiento y tienes tableros, deja una tarjeta con task_create.\n" +
  "Máximo 8 renglones: esto se lee en un canal, no es un informe.";

/** Encola la investigación (una por problema y día). Nunca lanza. */
export async function enqueueAlertInvestigation(opts: {
  ref: HookRef;
  alert: NormalizedAlert;
  alertMessageId: number;
  origin: string;
}): Promise<boolean> {
  try {
    const { ref, alert } = opts;
    if (!ref.ownerSub) return false;
    const { resolvedAgents, agentGroupId } = await import("../../agents.server");
    // Con la Software Factory instalada investiga @plan (su papel es leer y diagnosticar);
    // sin ella, el agente que creó el webhook.
    const { isInstalled } = await import("../apps/installed.server");
    const handle = (await isInstalled("factory").catch(() => false)) ? "plan" : ref.handle;
    const agents = await resolvedAgents();
    const agent = agents.find((a) => a.handle === handle) ?? agents.find((a) => a.handle === ref.handle);
    if (!agent) return false;
    // Conversación propia por canal: las alertas no se mezclan con la memoria del room.
    const groupId = await agentGroupId(agent, `alertas-${ref.channelId}`);
    const day = new Date().toISOString().slice(0, 10);
    const hash = createHash("sha1").update(alert.key).digest("hex").slice(0, 16);
    const { enqueueWakeup, mintWakeRef, armWakeups } = await import("../wakeups.server");
    const ok = await enqueueWakeup({
      key: `hook:${ref.channelId}:${hash}:${day}`,
      ref: mintWakeRef({
        sub: ref.ownerSub,
        ns: ref.ns,
        groupId,
        dest: {
          channelId: ref.channelId,
          parentId: opts.alertMessageId,
          topic: ref.topic,
          handle: agent.handle,
          name: agent.name,
          avatar: agent.avatar,
        },
      }),
      cause: `alerta de ${alert.source}`,
      text:
        `${ENCARGO}\n\nLa alerta (${alert.source}):\n**${alert.title}**\n${alert.body}` +
        (alert.link ? `\n${alert.link}` : ""),
      origin: opts.origin,
      dueAt: Math.floor(Date.now() / 1000) + 5,
    });
    if (ok) armWakeups(ref.ns);
    return ok;
  } catch (e) {
    console.error("[hook alert] no pude encolar la investigación", e);
    return false;
  }
}

// ── Tools del agente: crear, listar y borrar webhooks de alertas ─────────────


/** Base pública del tenant. El apex no sirve: el tenant sale del token, pero el host tiene que llegar a la app. */
async function hookBase(): Promise<string> {
  const { reqOrigin } = await import("../../origin.server");
  let base = (await reqOrigin().catch(() => "")).replace(/\/$/, "");
  if (!base || /^https?:\/\/teams\./.test(base)) {
    const { currentSlug } = await import("../tenant.server");
    const slug = await currentSlug().catch(() => null);
    const root = process.env.TEAMS_ROOT_DOMAIN ?? "teams.ghosty.studio";
    base = slug ? `https://${slug}.${root}` : base;
  }
  return base;
}

const cleanName = (v: unknown): string =>
  String(v ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

// Cómo se pega la URL en cada herramienta. Corto a propósito: el agente lo reformula.
const SETUP = {
  Datadog:
    "Integrations → Webhooks → New: pega la URL. En Payload usa " +
    '{"id":"$ID","title":"$EVENT_TITLE","body":"$EVENT_MSG","alert_transition":"$ALERT_TRANSITION","alert_id":"$ALERT_ID","link":"$LINK"}. ' +
    "Luego en cada monitor agrega @webhook-<nombre> al mensaje.",
  Grafana: "Alerting → Contact points → New → tipo Webhook: pega la URL (método POST).",
  "Better Stack": "Uptime → Integrations → Webhook: pega la URL.",
  UptimeRobot: "My Settings → Alert Contacts → Webhook: pega la URL y marca «Send as JSON».",
  "Cualquier otra": 'POST con JSON {"title","message","status":"firing|resolved","url"}.',
};

export function alertWebhookTools(dest: ToolDest | null): ConnectorTool[] {
  const soloCanal = { ok: false, error: "Los webhooks de alertas sólo se crean dentro de un canal, no en un DM." };
  return [
    {
      name: "alert_webhook_create",
      description:
        "Crea un webhook de ALERTAS DE MONITOREO para ESTE canal (Datadog, Grafana, Better Stack, UptimeRobot " +
        "o cualquier herramienta que mande webhooks). Cada alerta disparada se publica aquí y tú la investigas " +
        "sola en su hilo: real o ruido, causa y, si es chico, PR en borrador. Úsalo cuando pidan 'conecta mi " +
        "monitoreo', 'avísame cuando se caiga', 'que la fábrica vea mis alertas'. Devuelve la URL y cómo pegarla " +
        "en cada herramienta. ⚠️ La URL es un SECRETO: dásela sólo a quien la pidió y no la repitas en otros mensajes. " +
        "Para Sentry usa sentry_alerts_enable, no esto.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Nombre corto del webhook (p.ej. 'datadog-prod', 'uptime')" },
        },
        required: ["name"],
      },
      handler: async (sub, a) => {
        if (!dest?.channelId || dest.dmId) return soloCanal;
        const name = cleanName(a.name);
        if (!name) return { ok: false, error: "falta un nombre (letras, números y guiones)" };
        const { mintHookToken } = await import("./token.server");
        const { currentNamespace } = await import("../tenant.server");
        const token = mintHookToken({
          ns: await currentNamespace(),
          channelId: dest.channelId,
          topic: dest.topic || "general",
          handle: dest.handle || "ghosty",
          name: dest.name || "Ghosty",
          avatar: dest.avatar || "",
          ownerSub: sub,
          hook: name,
        });
        const { recordHook } = await import("./registry.server");
        await recordHook({ provider: HOOK_PROVIDER, ownerSub: sub, channelId: dest.channelId, org: "", project: name, createdBy: sub });
        return {
          ok: true,
          name,
          url: `${await hookBase()}/api/hooks/alert/${token}`,
          setup: SETUP,
          note: "Las alertas disparadas se investigan una vez por problema al día; las recuperaciones sólo se publican.",
        };
      },
    },
    {
      name: "alert_webhook_list",
      description: "Lista los webhooks de alertas de monitoreo configurados en este espacio (nombre, canal, cuándo).",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const { listHooks } = await import("./registry.server");
        const rows = await listHooks(HOOK_PROVIDER);
        return {
          ok: true,
          webhooks: rows.map((r) => ({ name: r.project, channelId: r.channelId, here: r.channelId === dest?.channelId, createdAt: r.createdAt })),
        };
      },
    },
    {
      name: "alert_webhook_delete",
      description:
        "Borra un webhook de alertas de ESTE canal por su nombre: deja de publicar aunque la herramienta siga " +
        "mandando. Confirma con el usuario antes de borrarlo.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "nombre del webhook (ver alert_webhook_list)" } },
        required: ["name"],
      },
      handler: async (_sub, a) => {
        if (!dest?.channelId || dest.dmId) return soloCanal;
        const name = cleanName(a.name);
        const { forgetHook } = await import("./registry.server");
        await forgetHook(HOOK_PROVIDER, dest.channelId, "", name);
        return { ok: true, deleted: name, note: "Quita también la URL en tu herramienta de monitoreo." };
      },
    },
  ];
}
