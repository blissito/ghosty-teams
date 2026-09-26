// Tools de Ghosty Ads (`ads_*`). SÓLO existen en un espacio que tiene la app instalada
// (`gt_installed_apps`) y en turnos de @ads: sin eso, esto devuelve [] y ni se anuncian ni
// se ejecutan.
//
// NINGUNA gasta dinero. Leen (cuenta, intereses, alcance, números) y la única que escribe
// deja una PROPUESTA: la plataforma publica su tarjeta y una persona decide con los botones.
import { notaNombres, type ConnectorTool, type ToolChannel } from "../connectors/impl";
import type { ToolDest } from "../connectors/tool-token.server";
import { isInstalled } from "./installed.server";
import { ADS_HANDLE } from "./ads-campaigns.server";

/** ¿Este turno es de @ads? Sin handle (p.ej. un cliente MCP) también se ofrecen. */
const isAdsTurn = (dest: ToolDest | null) => !dest?.handle || dest.handle === ADS_HANDLE;

export async function adsTools(_sub: string, dest: ToolDest | null): Promise<ConnectorTool[]> {
  if (!isAdsTurn(dest)) return [];
  if (!(await isInstalled("ads").catch(() => false))) return [];
  return tools(dest);
}

/** Hilo del turno: la raíz si estamos en uno; si no, el mensaje que invocó. */
function threadRoot(dest: ToolDest | null): number | null {
  if (!dest?.channelId) return null;
  return dest.parentId ?? dest.invokerMessageIds?.[0] ?? null;
}

/** Campañas que este turno puede leer: las del room donde está. */
async function roomCampaigns(dest: ToolDest | null) {
  if (!dest?.channelId) return [];
  const C = await import("./ads-campaigns.server");
  return C.campaignsOf([dest.channelId]);
}

const TARGETING_SCHEMA = {
  type: "object",
  description: "Segmentación. Edad 25–55 si no se dice; México si no hay países ni ciudades.",
  properties: {
    ageMin: { type: "number" },
    ageMax: { type: "number" },
    countries: { type: "array", items: { type: "string" }, description: 'Códigos ISO, p.ej. ["MX"]' },
    cities: {
      type: "array",
      items: {
        type: "object",
        properties: { key: { type: "string" }, name: { type: "string" }, radiusKm: { type: "number" } },
        required: ["key"],
      },
      description: "Ciudades con su key de Meta y radio opcional (1–80 km)",
    },
    interests: {
      type: "array",
      items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id", "name"] },
      description: "Intereses tal como los devolvió ads_interest_search",
    },
  },
};

function tools(dest: ToolDest | null): ConnectorTool[] {
  return [
    {
      name: "ads_account_info",
      description:
        "Ghosty Ads: la cuenta de anuncios y la página de Facebook conectadas en este espacio, y cuántas campañas hay en este room. " +
        "Llámala antes de proponer: si Meta no está conectado, dile a la persona que el dueño lo conecte en Ajustes → Apps → Ghosty Ads.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const { metaStatus } = await import("./ads-gs.server");
        const st = await metaStatus();
        const cs = await roomCampaigns(dest);
        return {
          connected: st.connected,
          adAccount: st.adAccount,
          page: st.page,
          ...(st.error ? { error: st.error } : {}),
          campaignsInRoom: cs.length,
          ...(st.connected ? {} : { hint: "Meta no está conectado: el dueño lo conecta en Ajustes → Apps → Ghosty Ads." }),
        };
      },
    },
    {
      name: "ads_interest_search",
      description:
        "Ghosty Ads: busca intereses REALES de Meta para segmentar (p.ej. «ferretería», «remodelación», «dueños de negocio»). " +
        "Devuelve id, nombre, ruta y tamaño de audiencia. Usa sólo estos ids en la propuesta. Haz varias búsquedas cortas.",
      inputSchema: { type: "object", properties: { q: { type: "string", description: "Palabra o frase corta" } }, required: ["q"] },
      handler: async (_sub, a) => {
        const q = String(a.q ?? "").trim().slice(0, 80);
        if (q.length < 2) return { ok: false, error: "escribe qué buscar en `q`" };
        const { gsAds } = await import("./ads-gs.server");
        const r = await gsAds("interests", { q });
        return r.ok ? { items: (r.items ?? []).slice(0, 25) } : { ok: false, error: r.error };
      },
    },
    {
      name: "ads_delivery_estimate",
      description: "Ghosty Ads: cuántas personas alcanza una segmentación según Meta (rango). Sirve para comparar segmentaciones antes de proponer.",
      inputSchema: { type: "object", properties: { targeting: TARGETING_SCHEMA }, required: ["targeting"] },
      handler: async (_sub, a) => {
        const { parseTargeting } = await import("./ads-proposal");
        const t = parseTargeting(a.targeting);
        if (typeof t === "string") return { ok: false, error: t };
        const { gsAds } = await import("./ads-gs.server");
        const r = await gsAds("estimate", { targeting: t });
        return r.ok ? { lower: r.lower, upper: r.upper, targeting: t } : { ok: false, error: r.error };
      },
    },
    {
      name: "ads_proposal_submit",
      description:
        "SÓLO @ads. Entrega la propuesta de una campaña click-to-Messenger: la plataforma publica en el hilo la tarjeta con la vista " +
        "previa real, la audiencia estimada y el techo total, con [Crear en pausa] y [Cancelar] para una PERSONA. No gasta nada ni " +
        "crea nada en Meta. Montos en pesos MXN; `end_time` en ISO.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Nombre de la campaña (se ve en Ads Manager)" },
          message: { type: "string", description: "El copy: texto principal del anuncio, corto" },
          headline: { type: "string", description: "Título corto (opcional)" },
          greeting: { type: "string", description: "Saludo de Messenger (opcional)" },
          media_url: { type: "string", description: "Imagen o video: https público o un adjunto del room (/api/attachment/…)" },
          targeting: TARGETING_SCHEMA,
          daily_budget: { type: "number", description: "Presupuesto diario en pesos MXN" },
          end_time: { type: "string", description: "Fin de la campaña en ISO, p.ej. 2026-10-31T23:59:00-06:00" },
        },
        required: ["name", "message", "media_url", "targeting", "daily_budget", "end_time"],
      },
      handler: async (sub, a) => {
        if (dest?.handle && dest.handle !== ADS_HANDLE) return { ok: false, error: "sólo @ads propone campañas" };
        if (!dest?.channelId) return { ok: false, error: "las campañas se proponen en un room, no en un DM" };
        const { parseProposal, maxTotal, attachmentIdOf } = await import("./ads-proposal");
        const p = parseProposal(a, Date.now());
        if (typeof p === "string") return { ok: false, error: p };
        const C = await import("./ads-campaigns.server");
        const fileId = attachmentIdOf(p.mediaUrl);
        if (fileId && !(await C.attachmentInChannel(fileId, dest.channelId)))
          return { ok: false, error: "ese adjunto no es de este room: usa uno que se haya subido aquí o una URL https" };
        const { gsAds, metaStatus } = await import("./ads-gs.server");
        const st = await metaStatus();
        if (!st.connected)
          return { ok: false, error: st.error ?? "Meta no está conectado en este espacio: el dueño lo conecta en Ajustes → Apps → Ghosty Ads" };
        // Estimado y vista previa: best-effort (la tarjeta se publica igual y los pide otra vez).
        const media = await C.forGs({ channelId: dest.channelId, proposal: p });
        const [est, prev] = await Promise.all([
          gsAds("estimate", { targeting: p.targeting }),
          "error" in media ? Promise.resolve(null) : gsAds("preview", { proposal: media }),
        ]);
        const stored = {
          ...p,
          estimate: est.ok ? { lower: est.lower, upper: est.upper } : null,
          previewSrc: prev?.ok ? prev.iframeSrc : null,
          previewNote: prev?.ok ? prev.note : null,
        };
        let root = threadRoot(dest);
        const { dbq } = await import("../../dbq.server");
        const rows = await dbq(
          `INSERT INTO gt_ads_campaigns (channel_id, root_msg_id, title, status, proposal_json, requested_by)
           VALUES (?, ?, ?, 'proposal', ?, ?) RETURNING id`,
          [dest.channelId, root, p.name, JSON.stringify(stored), sub],
        );
        const id = Number(rows[0].id);
        // Sin hilo (un turno top-level sin mensaje que lo invocó): la tarjeta es la raíz.
        const msgId = await C.postAsAds(dest.channelId, root, C.adsProposalFence(id));
        if (!root && msgId) {
          root = msgId;
          await dbq("UPDATE gt_ads_campaigns SET root_msg_id = ? WHERE id = ?", [root, id]);
        }
        return {
          ok: true,
          campaignId: id,
          maxTotal: maxTotal(p.dailyBudget, p.endTime, Date.now()),
          estimate: stored.estimate,
          ...(prev && !prev.ok ? { previewError: prev.error } : {}),
          note: `Tarjeta de la propuesta #${id} publicada. Una persona decide con [Crear en pausa] o [Cancelar]: no digas que la creaste. Di en una línea qué revisar.`,
        };
      },
    },
    {
      name: "ads_campaigns_list",
      description: "Ghosty Ads: las campañas #N de este room con su estado (propuesta, en pausa, activa, terminada…), presupuesto diario y fecha de fin.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const { adsStatusLabel } = await import("./ads-flow");
        const cs = await roomCampaigns(dest);
        return {
          items: cs.slice(0, 50).map((c) => ({
            id: c.id,
            title: c.title,
            status: c.status,
            statusLabel: adsStatusLabel(c.status),
            dailyBudget: c.proposal.dailyBudget ?? null,
            endTime: c.proposal.endTime || null,
            imported: c.imported,
            error: c.error,
          })),
        };
      },
    },
    {
      name: "ads_insights",
      description:
        "Ghosty Ads: los números de las campañas de este room que ya existen en Meta: gasto, conversaciones de Messenger, leads y " +
        "calificados del tablero de Ventas, y el costo por lead calificado. Sin `campaign_id`, todas las activas o en pausa.",
      inputSchema: { type: "object", properties: { campaign_id: { type: "number", description: "El #N (opcional)" } } },
      handler: async (_sub, a) => {
        const { inMeta } = await import("./ads-flow");
        const all = await roomCampaigns(dest);
        const n = Number(a.campaign_id);
        const pick = n > 0 ? all.filter((c) => c.id === n) : all.filter((c) => c.status === "active" || c.status === "paused");
        if (n > 0 && !pick.length) return { ok: false, error: `no hay campaña #${n} en este room` };
        const live = pick.filter((c) => inMeta(c.status));
        if (!live.length) return { items: [], note: "Ninguna campaña de este room existe todavía en Meta." };
        const C = await import("./ads-campaigns.server");
        const { byId, error } = await C.funnels(live);
        return {
          items: live.map((c) => ({ id: c.id, title: c.title, status: c.status, ...byId.get(c.id) })),
          ...(error ? { partialError: error } : {}),
          currency: "MXN",
        };
      },
    },
  ];
}

/** Bloque de contexto para turnos de @ads: el rol, la campaña del hilo y las tools. */
export async function adsContext(dest: ToolDest | null, toolChannel: ToolChannel = "gs-sdk"): Promise<string | null> {
  if (dest?.handle !== ADS_HANDLE) return null;
  if (!(await isInstalled("ads").catch(() => false))) return null;
  const { ADS_INSTRUCTIONS } = await import("./ads-role");
  const parts = ["[GHOSTY ADS instalada en este espacio. En ESTE turno actúas como @ads; tu identidad de siempre se queda, pero aplica este rol.", ADS_INSTRUCTIONS];
  const root = threadRoot(dest);
  if (dest.channelId && root) {
    const C = await import("./ads-campaigns.server");
    const c = await C.campaignOfThread(dest.channelId, root).catch(() => null);
    if (c) {
      const { adsStatusLabel } = await import("./ads-flow");
      parts.push(`Campaña de ESTE hilo: #${c.id} «${c.title}», ${adsStatusLabel(c.status).toLowerCase()}${c.error ? ` (error: ${c.error})` : ""}.`);
    }
  }
  parts.push(
    "Tus tools (ads_account_info, ads_interest_search, ads_delivery_estimate, ads_proposal_submit, ads_campaigns_list, ads_insights) ya están disponibles en este turno: LLÁMALAS; ninguna gasta." +
      notaNombres(toolChannel) +
      "]",
  );
  return parts.join(" ");
}
