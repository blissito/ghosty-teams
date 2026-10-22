// Tools de Ghosty Ads (`ads_*`). SÓLO existen en un espacio que tiene la app instalada
// (`gt_installed_apps`) y en turnos de @ads: sin eso, esto devuelve [] y ni se anuncian ni
// se ejecutan.
//
// NINGUNA gasta dinero. Leen (cuenta, intereses, alcance, números) y la única que escribe
// deja una PROPUESTA: la plataforma publica su tarjeta y una persona decide con los botones.
// Google Ads: se leen sus campañas (`ads_google_campaigns`/`insights`) y @ads PROPONE campañas
// de Búsqueda (`ads_google_proposal_submit`); crear en pausa, prender, pausar y cambiar presupuesto
// los pica una persona en la tarjeta, igual que en Meta.
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
  return tools(dest).map(guarded);
}

/** Ninguna tool de ads puede quedarse colgada: a los 28 s devuelve error (y el journal lo dice). */
const TOOL_TIMEOUT_MS = 28_000;

function guarded(t: ConnectorTool): ConnectorTool {
  return {
    ...t,
    handler: async (sub, args) => {
      const t0 = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let outcome = "ok";
      try {
        return await Promise.race([
          t.handler(sub, args),
          new Promise<{ ok: false; error: string }>((resolve) => {
            timer = setTimeout(() => {
              outcome = "timeout";
              resolve({ ok: false, error: `${t.name} tardó más de ${TOOL_TIMEOUT_MS / 1000} s; Meta o Ghosty Studio no contestaron. Inténtalo otra vez en un momento.` });
            }, TOOL_TIMEOUT_MS);
          }),
        ]);
      } catch (e) {
        outcome = "error";
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      } finally {
        clearTimeout(timer);
        console.log(`[ads tool ${t.name} ${Date.now() - t0}ms] ${outcome}`);
      }
    },
  };
}

/**
 * Las campañas de Google son de la cuenta, no de un room: sólo se leen desde el room de la app
 * (el que eligió el dueño al instalar), igual que /ads las enseña a quien ve ese room.
 */
async function googleAllowed(dest: ToolDest | null): Promise<string | null> {
  const { getAppConfig } = await import("./installed.server");
  const cfg = await getAppConfig<{ roomId?: number }>("ads").catch(() => null);
  if (dest?.channelId && cfg?.roomId && dest.channelId !== cfg.roomId) return "Las campañas de Google Ads sólo se consultan desde el room de Ghosty Ads.";
  return null;
}

const GOOGLE_LINK_HINT = "Google Ads no está conectado: el dueño lo conecta en Ghosty Ads (/ads).";

/** Las tools que escriben o buscan en Google: room de la app + cuenta vinculada. */
async function googleGate(dest: ToolDest | null): Promise<{ ok: false; error: string } | null> {
  const no = await googleAllowed(dest);
  if (no) return { ok: false, error: no };
  const { googleStatus } = await import("./ads-gs.server");
  const st = await googleStatus();
  if (st.link?.status !== "linked") return { ok: false, error: st.error ? `${GOOGLE_LINK_HINT} (${st.error})` : GOOGLE_LINK_HINT };
  return null;
}

/** id de Google → #N de las campañas que creó Ghosty. */
async function ownGoogleIds(): Promise<Map<string, number>> {
  const { dbq } = await import("../../dbq.server");
  const rows = await dbq("SELECT id, google_campaign_id FROM gt_ads_campaigns WHERE google_campaign_id IS NOT NULL", []).catch(() => []);
  return new Map(rows.map((r) => [String(r.google_campaign_id), Number(r.id)]));
}

/** Hilo del turno: la raíz si estamos en uno; si no, el mensaje que invocó. */
function threadRoot(dest: ToolDest | null): number | null {
  if (!dest?.channelId) return null;
  return dest.parentId ?? dest.invokerMessageIds?.[0] ?? null;
}

/**
 * La campaña a la que va una tool: `campaign_id` (de este room) > la del hilo > si el room
 * tiene UNA sola candidata, ésa; con varias, error que las lista para que @ads pregunte.
 * `mode`: "proposal" (ajustar una propuesta; `fresh` = pidió una nueva a propósito),
 * "live" (en pausa o activa), "any".
 */
async function resolveTarget(
  channelId: number,
  root: number | null,
  campaignId: unknown,
  fresh: boolean,
  mode: "proposal" | "live" | "any" = "proposal",
  /** Sólo campañas de esa plataforma (una propuesta de Meta no es versión de una de Google). */
  platform?: "meta" | "google",
): Promise<{ campaign: import("./ads-campaigns.server").Campaign | null } | { error: string }> {
  const C = await import("./ads-campaigns.server");
  const n = Number(campaignId);
  if (n > 0) {
    const c = await C.getCampaign(n);
    if (!c || c.channelId !== channelId) return { error: `no hay campaña #${n} en este room` };
    return { campaign: c };
  }
  if (fresh) return { campaign: null };
  const samePlatform = (c: { platform: string }) => !platform || c.platform === platform;
  const inThread = root ? await C.campaignOfThread(channelId, root) : null;
  if (inThread && samePlatform(inThread)) return { campaign: inThread };
  const fits = (s: string) => (mode === "proposal" ? s === "proposal" : mode === "live" ? s === "paused" || s === "active" : s !== "cancelled");
  const candidates = (await C.campaignsOf([channelId])).filter((c) => fits(c.status) && samePlatform(c));
  if (candidates.length === 1) return { campaign: candidates[0] };
  if (candidates.length > 1)
    return {
      error:
        `Este hilo no tiene campaña y en el room hay varias: ${candidates.map((c) => `#${c.id} «${c.title}» (${c.status})`).join(", ")}. ` +
        "Pregunta a cuál se refiere y vuelve a llamar con su campaign_id." +
        (mode === "proposal" ? " Si de verdad es una campaña nueva, pasa new_campaign: true." : ""),
    };
  return { campaign: null };
}

/** Campañas que este turno puede leer: las del room donde está. */
async function roomCampaigns(dest: ToolDest | null) {
  if (!dest?.channelId) return [];
  const C = await import("./ads-campaigns.server");
  return C.campaignsOf([dest.channelId]);
}

/** Cuerpo del mensaje con la tarjeta de cambios pendientes (`gt-ads-pending`, sólo el id). */
const pendingCardBody = (campaignId: number) =>
  `📝 Cambios pendientes en la campaña #${campaignId}\n\n` + "```gt-ads-pending\n" + JSON.stringify({ campaignId }) + "\n```";

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
    behaviors: {
      type: "array",
      items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id", "name"] },
      description:
        "Comportamientos de Meta (dueños de negocio, admins de página…), tal como vienen en `live` de ads_proposal_get. " +
        "En un cambio a campaña viva, si no los mandas se CONSERVAN los que ya tiene; manda [] sólo para quitarlos todos.",
    },
    publisherPlatforms: {
      type: "array",
      items: { type: "string", enum: ["facebook", "instagram", "messenger", "audience_network"] },
      description: "Dónde sale (opcional; sin esto Meta elige)",
    },
  },
};

function tools(dest: ToolDest | null): ConnectorTool[] {
  return [
    {
      name: "ads_account_info",
      description:
        "Ghosty Ads: la cuenta de anuncios y la página de Facebook conectadas en este espacio, si Google Ads está vinculado (y su moneda), y cuántas campañas hay en este room. " +
        "Llámala antes de proponer: si Meta no está conectado, dile a la persona que el dueño lo conecte en Ajustes → Apps → Ghosty Ads.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const { metaStatus, googleStatus } = await import("./ads-gs.server");
        const [st, g] = await Promise.all([metaStatus(), googleStatus()]);
        const cs = await roomCampaigns(dest);
        const gLinked = g.link?.status === "linked";
        return {
          connected: st.connected,
          adAccount: st.adAccount,
          page: st.page,
          ...(st.error ? { error: st.error } : {}),
          google: gLinked ? { linked: true, account: g.link!.name, customerId: g.link!.customerId, currency: g.link!.currency } : { linked: false, hint: GOOGLE_LINK_HINT },
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
        "SÓLO @ads. Entrega la propuesta de una campaña click-to-Messenger (o, con `link`, un anuncio web de columna derecha): la plataforma publica en el hilo la tarjeta con la vista " +
        "previa real, la audiencia estimada y el techo total, con [Crear en pausa] y [Cancelar] para una PERSONA. No gasta nada ni " +
        "crea nada en Meta. Montos en pesos MXN; `end_time` en ISO.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Nombre de la campaña (se ve en Ads Manager)" },
          message: { type: "string", description: "El copy: texto principal del anuncio, corto" },
          headline: { type: "string", description: "Título corto (opcional)" },
          greeting: { type: "string", description: "Saludo de Messenger (opcional; no aplica con link)" },
          link: {
            type: "string",
            description:
              "Sitio https al que lleva el anuncio. Con él sale SÓLO en la columna derecha de Facebook, en escritorio, con imagen " +
              "cuadrada (sin video) y botón LEARN_MORE por default. Sin link es click-to-Messenger. \"\" lo quita.",
          },
          campaign_id: { type: "number", description: "La propuesta que ajustas (#N), desde cualquier hilo del room" },
          new_campaign: { type: "boolean", description: "true SÓLO si de verdad es una campaña nueva (no un ajuste)" },
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
        // ¿A qué campaña va? `campaign_id` (desde cualquier hilo del room) > la del hilo > la
        // única propuesta abierta del room. Nunca se duplica una propuesta por pedir un ajuste
        // desde otro hilo (así nació la #5, casi igual a la #4).
        const target = await resolveTarget(dest.channelId, root0, a.campaign_id, !!a.new_campaign, "proposal", "meta");
        if ("error" in target) return { ok: false, error: target.error };
        const open0 = target.campaign;
        if (open0?.platform === "google")
          return { ok: false, error: `la #${open0.id} es una campaña de Google: ajústala con ads_google_proposal_submit, o pasa new_campaign: true para una de Meta` };
        if (open0 && open0.status !== "proposal" && Number(a.campaign_id) > 0)
          return {
            ok: false,
            error: `la campaña #${open0.id} ya está en Meta (${open0.status}). Para cambiar su segmentación o su fecha usa ads_campaign_change_propose; para cambiar texto o imagen, propón una campaña nueva con new_campaign: true.`,
          };
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
            // Pedido desde OTRO hilo: la tarjeta y la línea van al hilo de la campaña, y aquí una
            // nota corta (la misma línea, que abre el panel).
            const elsewhere = existing.rootMsgId !== root0 ? { channelId: dest.channelId, parentId: root0 } : null;
            const r = await C.saveVersion(existing, p, { editedBy: C.AGENT_EDITOR, display: "@ads" }, elsewhere);
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
      name: "ads_campaign_change_propose",
      description:
        "SÓLO @ads. Propone cambiar la segmentación y/o la fecha de fin de una campaña que YA está en Meta (en pausa o activa). " +
        "NO la aplica: deja «Cambios pendientes» en su panel con el diff y una PERSONA los aplica con [Aplicar en Meta]. " +
        "Sirve para: `targeting` (va COMPLETO y reemplaza edad, zonas e intereses; los comportamientos se conservan si no mandas `behaviors`), " +
        "`daily_budget` (pesos al día), `end_time`, `publisher_platforms` (quitar o poner Facebook, Instagram, " +
        "Messenger, Audience Network) y un ANUNCIO NUEVO (`message` + `media_url`, y opcionales `headline` y `cta`): al aplicarse se crea " +
        "otro anuncio y el viejo se pausa; Meta lo revisa de nuevo. Lee antes lo real con ads_proposal_get (trae `live`).",
      inputSchema: {
        type: "object",
        properties: {
          campaign_id: { type: "number", description: "El #N (si no, la del hilo)" },
          targeting: TARGETING_SCHEMA,
          end_time: { type: "string", description: "Nueva fecha de fin en ISO (opcional)" },
          daily_budget: { type: "number", description: "Nuevo presupuesto diario en pesos MXN (opcional)" },
          publisher_platforms: {
            type: "array",
            items: { type: "string", enum: ["facebook", "instagram", "messenger", "audience_network"] },
            description: "Dónde sale (opcional): las que se quedan",
          },
          message: { type: "string", description: "Anuncio nuevo: el copy (opcional)" },
          headline: { type: "string", description: "Anuncio nuevo: título corto (opcional)" },
          cta: { type: "string", enum: [...CTA_TYPES], description: "Anuncio nuevo: el botón (opcional)" },
          media_url: { type: "string", description: "Anuncio nuevo: el creativo, https o adjunto del room (obligatorio si cambias el anuncio)" },
        },
      },
      handler: async (_sub, a) => {
        if (dest?.handle && dest.handle !== ADS_HANDLE) return { ok: false, error: "sólo @ads propone cambios" };
        if (!dest?.channelId) return { ok: false, error: "las campañas viven en un room" };
        const C = await import("./ads-campaigns.server");
        const target = await resolveTarget(dest.channelId, threadRoot(dest), a.campaign_id, false, "live");
        if ("error" in target) return { ok: false, error: target.error };
        const c = target.campaign;
        if (!c || (c.status !== "paused" && c.status !== "active"))
          return { ok: false, error: "no encuentro una campaña en pausa o activa; pasa su `campaign_id`" };
        if (c.platform === "google")
          return {
            ok: false,
            error: `la #${c.id} es de Google Ads: su presupuesto y prender/pausar los pica una persona en su tarjeta (publícala con ads_campaign_show). Para cambiar títulos, palabras o zonas, propón una campaña nueva con ads_google_proposal_submit y new_campaign: true.`,
          };
        const { parseLiveChange, liveChangeDiff } = await import("./ads-proposal");
        const wantsAd = a.message != null || a.media_url != null || a.headline != null || a.cta != null;
        const detail = await C.liveDetail(c);
        const before = C.liveStateOf(c, detail);
        // Los comportamientos no los edita nadie a mano: si el agente no los manda, se heredan
        // de lo que corre hoy. Antes el `targeting` los reemplazaba y un ajuste de edad borraba
        // los 6 comportamientos de la campaña (26-sep).
        const liveBehaviors = (before.targeting as { behaviors?: unknown[] } | null)?.behaviors;
        const targetingIn =
          a.targeting && typeof a.targeting === "object" && !("behaviors" in a.targeting) && liveBehaviors?.length
            ? { ...a.targeting, behaviors: liveBehaviors }
            : a.targeting;
        const change = parseLiveChange(
          {
            targeting: targetingIn,
            dailyBudget: a.daily_budget,
            endTime: a.end_time,
            publisherPlatforms: a.publisher_platforms,
            // Lo que no mande del anuncio se hereda del que corre hoy (salvo el creativo, que es obligatorio).
            ...(wantsAd
              ? { ad: { message: a.message ?? before.message ?? "", headline: a.headline ?? before.headline ?? "", cta: a.cta ?? before.cta ?? "", mediaUrl: a.media_url ?? "" } }
              : {}),
          },
          Date.now(),
        );
        if (typeof change === "string") return { ok: false, error: change };
        if (change.ad) {
          const { attachmentIdOf } = await import("./ads-proposal");
          const fileId = attachmentIdOf(change.ad.mediaUrl);
          if (fileId && !(await C.attachmentInChannel(fileId, c.channelId))) return { ok: false, error: "ese adjunto no es de este room" };
        }
        const diff = liveChangeDiff(before, change);
        if (!diff.length) return { ok: false, error: "eso ya es lo que tiene la campaña en Meta: no hay nada que cambiar" };
        await C.setPending(c, change, C.AGENT_EDITOR);
        // La tarjeta `gt-ads-pending` lleva el diff y [Aplicar en Meta] ahí mismo. Antes era un
        // texto con un link que abría otra pestaña, y el botón vivía al fondo del panel lateral.
        const card = pendingCardBody(c.id);
        await C.postAsAds(c.channelId, c.rootMsgId, card);
        // Pedido desde otro hilo: la tarjeta también va donde se pidió.
        const here = threadRoot(dest);
        if (here !== c.rootMsgId || dest.channelId !== c.channelId) await C.postAsAds(dest.channelId, here, card).catch(() => {});
        return {
          ok: true,
          campaignId: c.id,
          diff,
          note:
            "Ya publiqué en el hilo la tarjeta de cambios pendientes con [Aplicar en Meta]: una persona lo toca ahí. No digas que ya cambiaron ni mandes a nadie a otro panel. " +
            "Avisa que Meta reinicia el aprendizaje al cambiar el público, y que un anuncio nuevo pasa otra vez por revisión.",
        };
      },
    },
    {
      name: "ads_campaign_show",
      description:
        "SÓLO @ads. Publica EN ESTE HILO la tarjeta viva de una campaña que ya está en Meta (estado, gasto → mensajes → leads → calificados, " +
        "[Pausar]/[Prender], [Cambiar presupuesto] y [Abrir]). Úsala cuando pregunten cómo va, si está corriendo, o pidan ver la campaña " +
        "en un hilo que no es el suyo. Si tiene cambios pendientes, publica también su tarjeta con [Aplicar en Meta].",
      inputSchema: { type: "object", properties: { campaign_id: { type: "number", description: "El #N (si no, la del hilo o la única activa)" } } },
      handler: async (_sub, a) => {
        if (dest?.handle && dest.handle !== ADS_HANDLE) return { ok: false, error: "sólo @ads" };
        if (!dest?.channelId) return { ok: false, error: "las campañas viven en un room" };
        const target = await resolveTarget(dest.channelId, threadRoot(dest), a.campaign_id, false, "live");
        if ("error" in target) return { ok: false, error: target.error };
        const c = target.campaign;
        if (!c?.metaCampaignId && !c?.googleCampaignId) return { ok: false, error: "esa campaña todavía no existe en Meta ni en Google; una propuesta se ve en su propia tarjeta" };
        const C = await import("./ads-campaigns.server");
        const here = threadRoot(dest);
        await C.postAsAds(dest.channelId, here, C.adsCampaignFence(c.id));
        if (c.pending) await C.postAsAds(dest.channelId, here, pendingCardBody(c.id));
        return {
          ok: true,
          campaignId: c.id,
          note: "Tarjeta publicada en el hilo; no repitas sus números. Di en una línea qué mirar" + (c.pending ? " y que los cambios pendientes se aplican con [Aplicar en Meta] en la tarjeta de abajo." : "."),
        };
      },
    },
    {
      name: "ads_pending_show",
      description:
        "SÓLO @ads. Vuelve a publicar EN ESTE HILO la tarjeta de cambios pendientes de una campaña, con su botón [Aplicar en Meta]. " +
        "Úsala cuando te pidan aplicar, confirmar o ver los cambios pendientes: tú no aplicas nada, la persona toca el botón de la tarjeta.",
      inputSchema: { type: "object", properties: { campaign_id: { type: "number", description: "El #N (si no, la del hilo)" } } },
      handler: async (_sub, a) => {
        if (dest?.handle && dest.handle !== ADS_HANDLE) return { ok: false, error: "sólo @ads" };
        if (!dest?.channelId) return { ok: false, error: "las campañas viven en un room" };
        const target = await resolveTarget(dest.channelId, threadRoot(dest), a.campaign_id, false, "live");
        if ("error" in target) return { ok: false, error: target.error };
        const c = target.campaign;
        if (!c) return { ok: false, error: "no encuentro la campaña; pasa su `campaign_id`" };
        if (!c.pending) return { ok: false, error: `la campaña #${c.id} no tiene cambios pendientes; propón uno con ads_campaign_change_propose` };
        const C = await import("./ads-campaigns.server");
        await C.postAsAds(dest.channelId, threadRoot(dest), pendingCardBody(c.id));
        return { ok: true, campaignId: c.id, note: "Tarjeta publicada en el hilo. Di en una línea: «toca [Aplicar en Meta] en la tarjeta de abajo»." };
      },
    },
    {
      name: "ads_review_status",
      description:
        "Ghosty Ads: cómo va la revisión de Meta del anuncio de una campaña creada (Aprobado, En revisión, Rechazado, Con observaciones) y " +
        "los motivos. Sin `campaign_id`, la del hilo (o la única en Meta del room).",
      inputSchema: { type: "object", properties: { campaign_id: { type: "number", description: "El #N (opcional)" } } },
      handler: async (_sub, a) => {
        if (!dest?.channelId) return { ok: false, error: "las campañas viven en un room" };
        const target = await resolveTarget(dest.channelId, threadRoot(dest), a.campaign_id, false, "live");
        if ("error" in target) return { ok: false, error: target.error };
        const c = target.campaign;
        if (!c?.metaCampaignId) return { ok: false, error: "esa campaña todavía no existe en Meta (una propuesta no se revisa)" };
        const C = await import("./ads-campaigns.server");
        const r = await C.reviewOf(c);
        if (!r) return { ok: false, error: "Meta no contestó la revisión; inténtalo en un momento" };
        const { REVIEW_LABELS } = await import("./ads-proposal");
        return { campaignId: c.id, state: r.state, stateLabel: REVIEW_LABELS[r.state], reasons: r.reasons };
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
        const target = await resolveTarget(dest.channelId, threadRoot(dest), a.campaign_id, false, "any");
        if ("error" in target) return { ok: false, error: target.error };
        const c = target.campaign;
        if (!c) return { ok: false, error: "este room no tiene campañas; propón una con ads_proposal_submit" };
        if (c.platform === "google" && c.google) {
          const gv = await C.listGoogleVersions(c.id);
          const { policy, ...proposal } = c.google;
          return {
            campaignId: c.id,
            platform: "google",
            status: c.status,
            version: gv[0]?.version ?? 1,
            changedFields: gv[0]?.changedFields ?? [],
            editedBy: gv[0]?.editedBy ?? C.AGENT_EDITOR,
            proposal,
            ...(policy?.length ? { policy } : {}),
            ...(c.error ? { error: c.error } : {}),
            googleCampaignId: c.googleCampaignId,
            versions: gv.map((v) => ({ version: v.version, editedBy: v.editedBy, changedFields: v.changedFields, createdAt: v.createdAt })),
          };
        }
        const versions = await C.listVersions(c.id);
        const { estimate, previewSrc: _s, previewNote, ...proposal } = c.proposal;
        const { CTA_LABELS, CTA_DEFAULT } = await import("./ads-proposal");
        const cta = proposal.cta ?? CTA_DEFAULT;
        return {
          campaignId: c.id,
          status: c.status,
          // En tus mensajes nombra el botón por esta etiqueta, nunca por su código.
          cta_label: CTA_LABELS[cta] ?? cta,
          version: versions[0]?.version ?? 1,
          changedFields: versions[0]?.changedFields ?? [],
          editedBy: versions[0]?.editedBy ?? C.AGENT_EDITOR,
          proposal,
          estimate: estimate ?? null,
          ...(previewNote ? { previewNote } : {}),
          versions: versions.map((v) => ({ version: v.version, editedBy: v.editedBy, changedFields: v.changedFields, createdAt: v.createdAt })),
          // Ya en Meta: lo que HOY tiene allá y lo que espera [Aplicar en Meta].
          ...(c.metaCampaignId ? { live: await C.liveDetail(c).catch(() => null), pending: c.pending } : {}),
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
            platform: c.platform,
            title: c.title,
            status: c.status,
            statusLabel: adsStatusLabel(c.status, c.platform),
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
        const live = pick.filter((c) => inMeta(c.status, c.platform));
        const googleOnes = pick.filter((c) => c.platform === "google" && c.googleCampaignId).map((c) => ({ id: c.id, googleCampaignId: c.googleCampaignId }));
        const googleNote = googleOnes.length ? { google: googleOnes, googleNote: "Las de Google se miden con ads_google_insights y su googleCampaignId." } : {};
        if (!live.length) return { items: [], note: "Ninguna campaña de este room existe todavía en Meta.", ...googleNote };
        const C = await import("./ads-campaigns.server");
        const { byId, error } = await C.funnels(live);
        return {
          items: live.map((c) => ({ id: c.id, title: c.title, status: c.status, ...byId.get(c.id) })),
          ...(error ? { partialError: error } : {}),
          currency: "MXN",
          ...googleNote,
        };
      },
    },
    {
      name: "ads_google_campaigns",
      description:
        "Ghosty Ads: las campañas de Google Ads de la cuenta vinculada: id, nombre, estado (ACTIVE, PAUSED, ENDED, NOT_ELIGIBLE, " +
        "SUSPENDED), presupuesto diario y motivos de Google. Las que creó Ghosty traen su #N (`ownId`). También puedes PROPONER campañas " +
        "de Búsqueda con ads_google_proposal_submit. Si no hay cuenta vinculada, dile al dueño que la conecte en Ghosty Ads (/ads).",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const no = await googleAllowed(dest);
        if (no) return { ok: false, error: no };
        const { googleAds, googleStatus } = await import("./ads-gs.server");
        const st = await googleStatus();
        if (st.link?.status !== "linked") return { linked: false, hint: GOOGLE_LINK_HINT, ...(st.error ? { error: st.error } : {}) };
        const r = await googleAds("campaigns");
        if (!r.ok) return r;
        const own = await ownGoogleIds();
        return {
          account: st.link.name,
          customerId: st.link.customerId,
          currency: st.link.currency,
          items: r.items.map((i) => (own.has(i.id) ? { ...i, ownId: own.get(i.id) } : i)),
        };
      },
    },
    {
      name: "ads_google_insights",
      description:
        "Ghosty Ads: números de Google Ads por campaña en los últimos N días (gasto, impresiones, clics, conversiones y su valor). " +
        "Sin `campaign_ids`, todas las campañas de la cuenta.",
      inputSchema: {
        type: "object",
        properties: {
          campaign_ids: { type: "array", items: { type: "string" }, description: "Ids de ads_google_campaigns (opcional)" },
          days: { type: "number", description: "Ventana en días (default 30, máx. 365)" },
        },
      },
      handler: async (_sub, a) => {
        const no = await googleAllowed(dest);
        if (no) return { ok: false, error: no };
        const { googleAds } = await import("./ads-gs.server");
        const ids = Array.isArray(a.campaign_ids) ? a.campaign_ids.map(String) : [];
        return googleAds("insights", { campaignIds: ids, days: Number(a.days) || 30 });
      },
    },
    {
      name: "ads_google_location_search",
      description:
        "Ghosty Ads (Google): busca ubicaciones REALES de Google Ads (país, estado, ciudad, municipio), p.ej. «Guadalajara», «Coyoacán». " +
        "Devuelve id, nombre, tipo y país. Usa sólo estos ids en `locations` de ads_google_proposal_submit y en keyword_ideas.",
      inputSchema: { type: "object", properties: { q: { type: "string", description: "Nombre del lugar" } }, required: ["q"] },
      handler: async (_sub, a) => {
        const gate = await googleGate(dest);
        if (gate) return gate;
        const q = String(a.q ?? "").trim().slice(0, 80);
        if (q.length < 2) return { ok: false, error: "escribe qué lugar buscar en `q`" };
        const { googleAds } = await import("./ads-gs.server");
        const r = await googleAds("locations", { q });
        return r.ok ? { items: (r.locations ?? []).slice(0, 20) } : { ok: false, error: r.error };
      },
    },
    {
      name: "ads_google_keyword_ideas",
      description:
        "Ghosty Ads (Google): ideas de palabras clave con su VOLUMEN real de búsquedas al mes, competencia y rango de puja, para las " +
        "ubicaciones de la campaña. Dale 2–5 semillas cortas (el servicio como lo busca la gente) y, si hay, la página del negocio. " +
        "Elige 5–20 con volumen y con intención de compra; evita las genéricas.",
      inputSchema: {
        type: "object",
        properties: {
          seeds: { type: "array", items: { type: "string" }, description: "Semillas, p.ej. [\"plomero urgente\", \"destapar caño\"]" },
          url: { type: "string", description: "Página del negocio (opcional)" },
          location_ids: { type: "array", items: { type: "string" }, description: "Ids de ads_google_location_search (México si no mandas)" },
        },
        required: ["seeds"],
      },
      handler: async (_sub, a) => {
        const gate = await googleGate(dest);
        if (gate) return gate;
        const seeds = (Array.isArray(a.seeds) ? a.seeds : [])
          .map((x) => String(x).trim().slice(0, 80))
          .filter(Boolean)
          .slice(0, 10);
        if (!seeds.length) return { ok: false, error: "manda al menos una semilla en `seeds`" };
        const ids = (Array.isArray(a.location_ids) ? a.location_ids : []).map((x) => String(x).replace(/\D/g, "")).filter(Boolean);
        const url = String(a.url ?? "").trim();
        const { googleAds } = await import("./ads-gs.server");
        const r = await googleAds("keyword_ideas", { seeds, ...(/^https:\/\//.test(url) ? { url } : {}), locationIds: ids.length ? ids : ["2484"] });
        return r.ok ? { ideas: (r.ideas ?? []).slice(0, 30) } : { ok: false, error: r.error };
      },
    },
    {
      name: "ads_google_proposal_submit",
      description:
        "SÓLO @ads. Entrega la propuesta de una campaña de BÚSQUEDA de Google Ads (anuncio de texto adaptable): la plataforma publica en el hilo " +
        "la tarjeta con la vista previa como sale en Google, las palabras con su volumen, las negativas, las zonas, la medición y el techo de " +
        "gasto, con [Crear en pausa] y [Cancelar] para una PERSONA. No crea ni gasta nada. En una propuesta abierta del hilo, manda sólo lo que " +
        "cambia: se guarda como versión nueva de la MISMA tarjeta. Concordancia sólo frase o exacta; sin `negatives` van las base.",
      inputSchema: {
        type: "object",
        properties: {
          campaign_id: { type: "number", description: "La propuesta de Google que ajustas (#N)" },
          new_campaign: { type: "boolean", description: "true SÓLO si de verdad es una campaña nueva" },
          name: { type: "string", description: "Nombre de la campaña (se ve en Google Ads)" },
          final_url: { type: "string", description: "Página https a la que llega quien da clic" },
          path1: { type: "string", description: "Ruta visible 1 (≤15, opcional), p.ej. agentes" },
          path2: { type: "string", description: "Ruta visible 2 (≤15, opcional)" },
          headlines: { type: "array", items: { type: "string" }, description: "10 a 15 títulos de ≤30 caracteres, distintos, en la voz del negocio" },
          descriptions: { type: "array", items: { type: "string" }, description: "4 descripciones de ≤90 caracteres" },
          keywords: {
            type: "array",
            items: {
              type: "object",
              properties: { text: { type: "string" }, match: { type: "string", enum: ["phrase", "exact"] }, volume: { type: "number" } },
              required: ["text"],
            },
            description: "Palabras clave (1–50) con su volumen de ads_google_keyword_ideas; match phrase (default) o exact",
          },
          negatives: { type: "array", items: { type: "string" }, description: "Palabras negativas; sin esto van las base (gratis, empleo, trabajo, curso, pdf, qué es)" },
          locations: {
            type: "array",
            items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id", "name"] },
            description: "Ubicaciones de ads_google_location_search (México si no mandas ni radio)",
          },
          radius: {
            type: "object",
            properties: { lat: { type: "number" }, lng: { type: "number" }, km: { type: "number" }, label: { type: "string" } },
            description: "Radio alrededor del negocio (1–80 km), opcional",
          },
          phone: { type: "string", description: "Teléfono del negocio: extensión de llamada + medición de llamadas. Sin él, la campaña va sin medición" },
          daily_budget: { type: "number", description: "Presupuesto diario en la moneda de la cuenta (20–50,000)" },
          max_cpc: { type: "number", description: "Tope por clic (opcional)" },
          end_date: { type: "string", description: "Fin AAAA-MM-DD (opcional, ≤90 días)" },
        },
      },
      handler: async (sub, a) => {
        if (dest?.handle && dest.handle !== ADS_HANDLE) return { ok: false, error: "sólo @ads propone campañas" };
        if (!dest?.channelId) return { ok: false, error: "las campañas se proponen en un room, no en un DM" };
        const gate = await googleGate(dest);
        if (gate) return gate;
        const G = await import("./ads-google-proposal");
        const C = await import("./ads-campaigns.server");
        const root0 = threadRoot(dest);
        const target = await resolveTarget(dest.channelId, root0, a.campaign_id, !!a.new_campaign, "proposal", "google");
        if ("error" in target) return { ok: false, error: target.error };
        const open0 = target.campaign;
        if (open0 && open0.platform !== "google") return { ok: false, error: `la #${open0.id} es de Meta: pasa new_campaign: true para proponer una de Google` };
        if (open0 && open0.status !== "proposal" && Number(a.campaign_id) > 0)
          return { ok: false, error: `la campaña #${open0.id} ya está en Google Ads (${open0.status}): para cambiar textos o palabras propón una nueva con new_campaign: true` };
        const isVersion = !!open0?.google && open0.status === "proposal";
        // Un agente que manda `negatives: []` en una nueva quiere las base, no ninguna.
        const input = { ...a, ...(!isVersion && Array.isArray(a.negatives) && !a.negatives.length ? { negatives: undefined } : {}) };
        const p = G.parseGoogleProposal(isVersion ? G.mergeGoogleSubmit(open0!.google!, input) : input, Date.now(), { baseNegatives: !isVersion });
        if (typeof p === "string") return { ok: false, error: p };
        const { googleStatus } = await import("./ads-gs.server");
        const currency = (await googleStatus()).link?.currency ?? null;
        const max = G.googleMaxTotal(p.dailyBudget, p.endDate, Date.now());
        const extra = {
          maxTotal: max.total,
          maxTotalDays: max.days,
          currency,
          ...(p.phone ? {} : { warning: "Sin teléfono no hay medición de llamadas: pide uno si el negocio contesta por teléfono." }),
        };
        if (isVersion && open0) {
          try {
            const elsewhere = open0.rootMsgId !== root0 ? { channelId: dest.channelId, parentId: root0 } : null;
            const r = await C.saveGoogleVersion(open0, p, { editedBy: C.AGENT_EDITOR, display: "@ads" }, elsewhere);
            return { ok: true, campaignId: open0.id, version: r.version, ...extra, note: `La tarjeta de la propuesta #${open0.id} ya muestra la v${r.version} (misma tarjeta). Di en una línea qué cambió.` };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        }
        const { dbq } = await import("../../dbq.server");
        const rows = await dbq(
          `INSERT INTO gt_ads_campaigns (channel_id, root_msg_id, title, status, proposal_json, requested_by, platform)
           VALUES (?, ?, ?, 'proposal', ?, ?, 'google') RETURNING id`,
          [dest.channelId, root0, p.name.slice(0, 120), JSON.stringify(p), sub],
        );
        const id = Number(rows[0].id);
        await C.recordFirstVersion(id, p, C.AGENT_EDITOR);
        const msgId = await C.postAsAds(dest.channelId, root0, C.adsProposalFence(id));
        if (msgId) await dbq("UPDATE gt_ads_campaigns SET card_msg_id = ?, root_msg_id = COALESCE(root_msg_id, ?) WHERE id = ?", [msgId, msgId, id]);
        return {
          ok: true,
          campaignId: id,
          version: 1,
          ...extra,
          note: `Tarjeta de la propuesta #${id} (Google Búsqueda) publicada. Una persona decide con [Crear en pausa] o [Cancelar]: no digas que la creaste. Si piden cambios, vuelve a llamar ads_google_proposal_submit en este hilo con sólo lo que cambia. Di en una línea qué revisar.`,
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
      parts.push(
        `Campaña de ESTE hilo: #${c.id} «${c.title}» (${c.platform === "google" ? "Google Ads, Búsqueda" : "Meta"}), ${adsStatusLabel(c.status, c.platform).toLowerCase()}${c.error ? ` (error: ${c.error})` : ""}.`,
      );
      if (c.platform === "google") {
        if (c.status === "proposal" && c.google) {
          const gv = await C.listGoogleVersions(c.id).catch(() => []);
          const { summarizeGoogleProposal, describeGoogleChanges } = await import("./ads-google-proposal");
          const { policy: _p, ...current } = c.google;
          if (gv[0]) parts.push(`La tarjeta va en la v${gv[0].version}; ads_google_proposal_submit aquí guarda la siguiente versión en la MISMA tarjeta y lo que no mandes se queda como está.`);
          parts.push(`Propuesta de Google VIGENTE (no la preguntes): ${summarizeGoogleProposal(current)}.`);
          const humans = gv.filter((v) => v.editedBy !== C.AGENT_EDITOR).slice(0, 3);
          if (humans.length)
            parts.push(
              "Ediciones a mano: " +
                humans.map((h) => `${h.editedBy} en la v${h.version} (cambió ${describeGoogleChanges(h.changedFields)})`).join("; ") +
                ". Respétalas en la siguiente versión.",
            );
        }
        if (c.status === "error" && c.google?.policy?.length)
          parts.push("Google rechazó piezas por política (campo policy de ads_proposal_get): reescribe SÓLO esas y manda la versión nueva; la persona le da «Reintentar».");
        if (c.status === "paused" || c.status === "active")
          parts.push("Es una CAMPAÑA EN GOOGLE ADS: prender, pausar y cambiar presupuesto los pica una persona en su tarjeta (ads_campaign_show la publica). Sus números: ads_google_insights con su googleCampaignId.");
      } else if (c.status === "paused" || c.status === "active") {
        parts.push(
          `Es una CAMPAÑA EN META (no una propuesta): lee lo real con ads_proposal_get (campo live). Para cambiar segmentación, fecha, ubicaciones ` +
            `o el anuncio usa ads_campaign_change_propose (quedan pendientes; una persona los aplica).` +
            (c.pending ? ` Ya hay cambios pendientes de ${c.pending.proposedBy}: no los repitas.` : ""),
        );
      }
      if (c.status === "proposal" && c.platform !== "google") {
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
    "Tus tools (ads_account_info, ads_proposal_get, ads_campaign_change_propose, ads_campaign_show, ads_pending_show, ads_review_status, ads_interest_search, ads_location_search, ads_delivery_estimate, ads_proposal_submit, ads_campaigns_list, ads_insights, ads_google_campaigns, ads_google_insights, ads_google_location_search, ads_google_keyword_ideas, ads_google_proposal_submit) ya están disponibles en este turno: LLÁMALAS; ninguna gasta." +
      notaNombres(toolChannel) +
      "]",
  );
  return parts.join(" ");
}
