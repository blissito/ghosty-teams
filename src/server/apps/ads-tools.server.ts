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
import { CTA_TYPES } from "./ads-proposal";

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
    regions: {
      type: "array",
      items: { type: "object", properties: { key: { type: "string" }, name: { type: "string" } }, required: ["key"] },
      description: "Estados con su key de ads_location_search",
    },
    cities: {
      type: "array",
      items: {
        type: "object",
        properties: { key: { type: "string" }, name: { type: "string" }, radiusKm: { type: "number" } },
        required: ["key"],
      },
      description: "Ciudades con su key de ads_location_search y radio de 17 a 80 km (25 si no sabes)",
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
      name: "ads_location_search",
      description:
        "Ghosty Ads: busca zonas de Meta para segmentar (país, estado o ciudad), p.ej. «Monterrey», «Jalisco». Devuelve key, nombre, " +
        "tipo y país. País → targeting.countries con countryCode; estado → targeting.regions {key,name}; ciudad → targeting.cities {key,name,radiusKm 17–80}.",
      inputSchema: { type: "object", properties: { q: { type: "string", description: "Nombre de la zona" } }, required: ["q"] },
      handler: async (_sub, a) => {
        const q = String(a.q ?? "").trim().slice(0, 80);
        if (q.length < 2) return { ok: false, error: "escribe qué zona buscar en `q`" };
        const { gsAds } = await import("./ads-gs.server");
        const r = await gsAds("locations", { q });
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
          cta: {
            type: "string",
            enum: [...CTA_TYPES],
            description: "Botón del anuncio según el giro; si dudas, MESSAGE_PAGE (default)",
          },
          media_url: { type: "string", description: "Imagen o video: https público o un adjunto del room (/api/attachment/…)" },
          targeting: TARGETING_SCHEMA,
          daily_budget: { type: "number", description: "Presupuesto diario en pesos MXN" },
          end_time: { type: "string", description: "Fin de la campaña en ISO, p.ej. 2026-10-31T23:59:00-06:00" },
        },
        // Sin `required`: en una propuesta abierta basta mandar lo que cambia. Una nueva sigue
        // exigiendo todo (lo valida parseProposal).
      },
      handler: async (sub, a) => {
        if (dest?.handle && dest.handle !== ADS_HANDLE) return { ok: false, error: "sólo @ads propone campañas" };
        if (!dest?.channelId) return { ok: false, error: "las campañas se proponen en un room, no en un DM" };
        const { parseProposal, maxTotal, attachmentIdOf, mergeSubmit, submitMode } = await import("./ads-proposal");
        const C = await import("./ads-campaigns.server");
        const root0 = threadRoot(dest);
        const open0 = root0 ? await C.campaignOfThread(dest.channelId, root0) : null;
        const isVersion = !!open0 && submitMode(open0) === "version";
        const { estimate: _e, previewSrc: _s, previewNote: _n, ...current } = open0?.proposal ?? ({} as NonNullable<typeof open0>["proposal"]);
        // Versión nueva: lo que no se manda se hereda de la vigente (no se pisa lo editado a mano).
        const p = parseProposal(isVersion ? mergeSubmit(current, a) : a, Date.now());
        if (typeof p === "string") return { ok: false, error: p };
        const fileId = attachmentIdOf(p.mediaUrl);
        if (fileId && !(await C.attachmentInChannel(fileId, dest.channelId)))
          return { ok: false, error: "ese adjunto no es de este room: usa uno que se haya subido aquí o una URL https" };
        const { metaStatus } = await import("./ads-gs.server");
        const st = await metaStatus();
        if (!st.connected)
          return { ok: false, error: st.error ?? "Meta no está conectado en este espacio: el dueño lo conecta en Ajustes → Apps → Ghosty Ads" };
        let root = threadRoot(dest);
        // Una tarjeta por campaña: en un hilo que ya tiene una propuesta abierta, esto es su
        // versión nueva (misma tarjeta, se repinta); no otra fila ni otra tarjeta.
        const existing = isVersion ? open0 : null;
        if (existing) {
          try {
            const r = await C.saveVersion(existing, p, { editedBy: C.AGENT_EDITOR, display: "@ads" });
            return {
              ok: true,
              campaignId: existing.id,
              version: r.version,
              maxTotal: maxTotal(p.dailyBudget, p.endTime, Date.now()),
              ...(r.previewError ? { previewError: r.previewError } : {}),
              note: `La tarjeta de la propuesta #${existing.id} ya muestra la v${r.version} (misma tarjeta, no otra). Di en una línea qué cambió.`,
            };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        }
        // Estimado y vista previa: best-effort (la tarjeta se publica igual y los pide otra vez).
        const { previewError, ...stored } = await C.previewFor(dest.channelId, p);
        const { dbq } = await import("../../dbq.server");
        const rows = await dbq(
          `INSERT INTO gt_ads_campaigns (channel_id, root_msg_id, title, status, proposal_json, requested_by)
           VALUES (?, ?, ?, 'proposal', ?, ?) RETURNING id`,
          [dest.channelId, root, p.name, JSON.stringify(stored), sub],
        );
        const id = Number(rows[0].id);
        await C.recordFirstVersion(id, stored, C.AGENT_EDITOR);
        // Sin hilo (un turno top-level sin mensaje que lo invocó): la tarjeta es la raíz.
        const msgId = await C.postAsAds(dest.channelId, root, C.adsProposalFence(id));
        if (msgId) {
          // La tarjeta de la propuesta es también la de la campaña cuando se cree en pausa.
          await dbq("UPDATE gt_ads_campaigns SET card_msg_id = ?, root_msg_id = COALESCE(root_msg_id, ?) WHERE id = ?", [msgId, msgId, id]);
        }
        return {
          ok: true,
          campaignId: id,
          version: 1,
          maxTotal: maxTotal(p.dailyBudget, p.endTime, Date.now()),
          estimate: stored.estimate,
          ...(previewError ? { previewError } : {}),
          note: `Tarjeta de la propuesta #${id} publicada. Una persona decide con [Crear en pausa] o [Cancelar]: no digas que la creaste. Si te piden cambios, vuelve a llamar ads_proposal_submit en este hilo: se actualiza la MISMA tarjeta. Di en una línea qué revisar.`,
        };
      },
    },
    {
      name: "ads_proposal_get",
      description:
        "Ghosty Ads: la propuesta VIGENTE completa (copy, título, botón, creativo, segmentación, presupuesto, fechas), su versión y " +
        "qué campos cambió, más el resumen de versiones (quién y qué). Sin `campaign_id`, la del hilo. Léela ANTES de ajustar una " +
        "propuesta: nunca preguntes lo que puedes leer aquí.",
      inputSchema: { type: "object", properties: { campaign_id: { type: "number", description: "El #N (opcional)" } } },
      handler: async (_sub, a) => {
        if (!dest?.channelId) return { ok: false, error: "las campañas viven en un room" };
        const C = await import("./ads-campaigns.server");
        const n = Number(a.campaign_id);
        let c = n > 0 ? await C.getCampaign(n) : null;
        if (n > 0 && c?.channelId !== dest.channelId) return { ok: false, error: `no hay campaña #${n} en este room` };
        if (!c) {
          const root = threadRoot(dest);
          c = root ? await C.campaignOfThread(dest.channelId, root) : null;
        }
        if (!c) return { ok: false, error: "este hilo no tiene campaña; pasa `campaign_id` o propón una con ads_proposal_submit" };
        const versions = await C.listVersions(c.id);
        const { estimate, previewSrc: _s, previewNote, ...proposal } = c.proposal;
        return {
          campaignId: c.id,
          status: c.status,
          version: versions[0]?.version ?? 1,
          changedFields: versions[0]?.changedFields ?? [],
          editedBy: versions[0]?.editedBy ?? C.AGENT_EDITOR,
          proposal,
          estimate: estimate ?? null,
          ...(previewNote ? { previewNote } : {}),
          versions: versions.map((v) => ({ version: v.version, editedBy: v.editedBy, changedFields: v.changedFields, createdAt: v.createdAt })),
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
      if (c.status === "proposal") {
        const versions = await C.listVersions(c.id).catch(() => []);
        // Las ediciones humanas desde la última versión de @ads (si no hay, la humana más reciente).
        const lastAgent = versions.findIndex((v) => v.editedBy === C.AGENT_EDITOR);
        const recent = versions.slice(0, lastAgent === -1 ? versions.length : lastAgent).filter((v) => v.editedBy !== C.AGENT_EDITOR);
        const humans = recent.length ? recent : versions.filter((v) => v.editedBy !== C.AGENT_EDITOR).slice(0, 1);
        const { describeChanges } = await import("./ads-proposal");
        if (versions[0]) parts.push(`La tarjeta va en la v${versions[0].version}; ads_proposal_submit aquí guarda la siguiente versión en la MISMA tarjeta y lo que no mandes se queda como está.`);
        const { summarizeProposal } = await import("./ads-proposal");
        const { estimate: _e, previewSrc: _s, previewNote: _n, ...current } = c.proposal;
        if (current.message) parts.push(`Propuesta VIGENTE (no la preguntes): ${summarizeProposal(current)}.`);
        if (humans.length)
          parts.push(
            "Ediciones a mano: " +
              humans.map((h) => `${h.editedBy} en la v${h.version} (cambió ${describeChanges(h.changedFields)})`).join("; ") +
              ". Ya están en la propuesta vigente de arriba: respeta sus cambios y su estilo en la siguiente versión; no los deshagas.",
          );
      }
    }
  }
  parts.push(
    "Tus tools (ads_account_info, ads_proposal_get, ads_interest_search, ads_location_search, ads_delivery_estimate, ads_proposal_submit, ads_campaigns_list, ads_insights) ya están disponibles en este turno: LLÁMALAS; ninguna gasta." +
      notaNombres(toolChannel) +
      "]",
  );
  return parts.join(" ");
}
