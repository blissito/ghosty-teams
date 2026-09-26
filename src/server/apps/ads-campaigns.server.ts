// Campañas de Ghosty Ads: persistencia, botones y publicación en el hilo.
//
// La plataforma publica las tarjetas y aplica cada cambio con guardia (`WHERE status = ?`):
// dos clics a «Crear en pausa» crean UNA campaña. El agente sólo propone
// (`ads_proposal_submit`); crear, prender, pausar y cambiar presupuesto los pica una persona
// desde su tarjeta, y cada uno queda en el hilo con su nombre.
import { dbq } from "../../dbq.server";
import { adsStatusLabel, nextAdsStatus, type AdsEvent, type AdsStatus } from "./ads-flow";
import { attachmentIdOf, budgetRejection, funnelOf, mxn, type Funnel, type Proposal, type StoredProposal } from "./ads-proposal";
import { gsAds, type GsCampaign } from "./ads-gs.server";

export const ADS_HANDLE = "ads";

export type Campaign = {
  id: number;
  channelId: number;
  rootMsgId: number | null;
  cardMsgId: number | null;
  title: string;
  status: AdsStatus;
  proposal: StoredProposal;
  metaCampaignId: string | null;
  metaAdsetId: string | null;
  metaAdId: string | null;
  adIds: string[];
  requestedBy: string;
  approvedBy: string | null;
  error: string | null;
  imported: boolean;
  createdAt: number;
  updatedAt: number;
};

function parseJson<T>(s: unknown, fallback: T): T {
  try {
    return s ? (JSON.parse(String(s)) as T) : fallback;
  } catch {
    return fallback;
  }
}

const toCampaign = (r: Record<string, any>): Campaign => {
  const adIds = parseJson<string[]>(r.ad_ids, []);
  return {
    id: Number(r.id),
    channelId: Number(r.channel_id),
    rootMsgId: r.root_msg_id != null ? Number(r.root_msg_id) : null,
    cardMsgId: r.card_msg_id != null ? Number(r.card_msg_id) : null,
    title: String(r.title),
    status: r.status as AdsStatus,
    proposal: parseJson<StoredProposal>(r.proposal_json, {} as StoredProposal),
    metaCampaignId: r.meta_campaign_id ?? null,
    metaAdsetId: r.meta_adset_id ?? null,
    metaAdId: r.meta_ad_id ?? null,
    adIds: adIds.length ? adIds : r.meta_ad_id ? [String(r.meta_ad_id)] : [],
    requestedBy: String(r.requested_by),
    approvedBy: r.approved_by ?? null,
    error: r.error ?? null,
    imported: !!r.imported,
    createdAt: Number(r.created_at ?? 0),
    updatedAt: Number(r.updated_at ?? 0),
  };
};

export async function getCampaign(id: number): Promise<Campaign | null> {
  const rows = await dbq("SELECT * FROM gt_ads_campaigns WHERE id = ?", [id]);
  return rows[0] ? toCampaign(rows[0]) : null;
}

/** Campañas de un room (la más nueva primero). */
export async function campaignsOf(channelIds: number[]): Promise<Campaign[]> {
  if (!channelIds.length) return [];
  const rows = await dbq(
    `SELECT * FROM gt_ads_campaigns WHERE channel_id IN (${channelIds.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 500`,
    channelIds,
  ).catch(() => []);
  return rows.map(toCampaign);
}

/** La campaña que se propuso en este hilo (la última), si hay. */
export async function campaignOfThread(channelId: number, rootMsgId: number): Promise<Campaign | null> {
  const rows = await dbq("SELECT * FROM gt_ads_campaigns WHERE channel_id = ? AND root_msg_id = ? ORDER BY id DESC LIMIT 1", [channelId, rootMsgId]);
  return rows[0] ? toCampaign(rows[0]) : null;
}

/**
 * Aplica un evento con guardia: sólo si la fila sigue en el estado leído. Lanza con un
 * mensaje para la persona si no aplica o si otra persona se adelantó.
 */
export async function applyAdsEvent(c: Campaign, event: AdsEvent, patch: Record<string, unknown> = {}): Promise<Campaign> {
  const next = nextAdsStatus(c.status, event);
  if (!next) throw new Error(`la campaña #${c.id} está «${adsStatusLabel(c.status)}»: eso no aplica ahora`);
  const cols = Object.keys(patch);
  const sets = ["status = ?", "updated_at = unixepoch()", ...cols.map((k) => `${k} = ?`)];
  const rows = await dbq(`UPDATE gt_ads_campaigns SET ${sets.join(", ")} WHERE id = ? AND status = ? RETURNING *`, [
    next,
    ...cols.map((k) => patch[k] as never),
    c.id,
    c.status,
  ]);
  if (!rows[0]) throw new Error(`la campaña #${c.id} cambió mientras tanto; vuelve a mirarla`);
  const { refreshRoom } = await import("./factory-runs.server");
  void refreshRoom(c.channelId);
  return toCampaign(rows[0]);
}

// ── Publicar en el room ──────────────────────────────────────────────────────

async function adsIdentity() {
  const { resolvedAgents } = await import("../../agents.server");
  const a = (await resolvedAgents().catch(() => [])).find((x) => x.handle === ADS_HANDLE);
  return { handle: ADS_HANDLE, name: a?.name ?? "Ads", avatar: a?.avatar ?? "" };
}

/** Publica con la cara de @ads (en el hilo si `parentId`). `postAgent` no despierta a nadie. */
export async function postAsAds(channelId: number, parentId: number | null, body: string): Promise<number | null> {
  try {
    const db = await import("../../db.server");
    const bus = await import("../bus.server");
    const { currentNamespace } = await import("../tenant.server");
    const who = await adsIdentity();
    const { id } = await db.postAgent(channelId, parentId, body, "msg", who.handle, who.name, "general", who.avatar);
    const msg = await db.getMessage(id);
    if (msg) bus.publish(bus.ch.room(await currentNamespace(), channelId), { t: "message:new", msg });
    return id;
  } catch (e) {
    console.error("[ads] no pude publicar en el room", e);
    return null;
  }
}

export const adsProposalFence = (campaignId: number) => "```gt-ads-proposal\n" + JSON.stringify({ campaignId }) + "\n```";
export const adsCampaignFence = (campaignId: number) => "```gt-ads-campaign\n" + JSON.stringify({ campaignId }) + "\n```";

/** En el hilo de la campaña; si no tiene hilo (importada), top-level en su room. */
async function postInThread(c: Campaign, body: string) {
  return postAsAds(c.channelId, c.rootMsgId, body);
}

/** La tarjeta viva (`gt-ads-campaign`), UNA vez por campaña. Nunca lanza. */
export async function ensureCampaignCard(c: Campaign): Promise<void> {
  try {
    const rows = await dbq("SELECT card_msg_id FROM gt_ads_campaigns WHERE id = ?", [c.id]);
    if (rows[0]?.card_msg_id) return;
    const id = await postInThread(c, adsCampaignFence(c.id));
    if (id) await dbq("UPDATE gt_ads_campaigns SET card_msg_id = ? WHERE id = ? AND card_msg_id IS NULL", [id, c.id]);
  } catch (e) {
    console.error("[ads] no pude publicar la tarjeta de la campaña", e);
  }
}

// ── El creativo ──────────────────────────────────────────────────────────────

/** ¿Ese adjunto se subió a ESTE room? (con el id de otro, se filtraría un archivo ajeno). */
export async function attachmentInChannel(fileId: string, channelId: number): Promise<boolean> {
  const rows = await dbq(
    `SELECT 1 FROM gc_attachments a JOIN gc_messages m ON m.id = a.message_id WHERE a.file_id = ? AND m.channel_id = ? LIMIT 1`,
    [fileId, channelId],
  ).catch(() => []);
  return rows.length > 0;
}

/**
 * La propuesta tal como la necesita gs: un adjunto del room se vuelve una URL firmada
 * fresca (vale ~1 h; se acuña al picar el botón, no al proponer, porque la persona puede
 * tardar días en decidir). Meta la baja una vez al crear el anuncio.
 */
export async function forGs(c: { channelId: number; proposal: StoredProposal }): Promise<Proposal | { error: string }> {
  const { estimate: _e, previewSrc: _p, previewNote: _n, ...p } = c.proposal;
  const fileId = attachmentIdOf(p.mediaUrl);
  if (!fileId) return p;
  if (!(await attachmentInChannel(fileId, c.channelId))) return { error: "el creativo no es un adjunto de este room" };
  const { mintReadUrl } = await import("../easybits-files.server");
  const url = await mintReadUrl(fileId).catch(() => null);
  return url ? { ...p, mediaUrl: url } : { error: "no pude abrir el creativo adjunto" };
}

// ── Los botones ──────────────────────────────────────────────────────────────

type Who = { sub: string; name?: string | null };
const whoName = (me: Who) => me.name || "Alguien";

/** [Crear en pausa]: la campaña, el conjunto y el anuncio nacen en PAUSED en Meta. */
export async function createPaused(c: Campaign, me: Who): Promise<Campaign> {
  const claimed = await applyAdsEvent(c, "create", { approved_by: me.sub, error: null });
  const p = await forGs(claimed);
  const r = "error" in p ? { ok: false as const, error: p.error } : await gsAds("create_paused", { proposal: p, requestedBy: me.sub });
  if (!r.ok) {
    const failed = await applyAdsEvent(claimed, "create_failed", { error: r.error.slice(0, 1000) });
    await postInThread(failed, `⚠️ No se pudo crear la campaña #${c.id} en Meta: ${r.error}\nNo se gastó nada. Corrígelo con @ads o vuelve a intentarlo desde la tarjeta.`);
    throw new Error(r.error);
  }
  const done = await applyAdsEvent(claimed, "created", {
    meta_campaign_id: r.campaignId,
    meta_adset_id: r.adsetId,
    meta_ad_id: r.adId,
    ad_ids: JSON.stringify([r.adId]),
  });
  await postInThread(
    done,
    `⏸️ ${whoName(me)} creó la campaña #${c.id} **en pausa** en Meta. No gasta nada hasta que alguien la prenda desde su tarjeta.`,
  );
  await ensureCampaignCard(done);
  return done;
}

/** [Cancelar] una propuesta (o una que falló al crearse). No toca Meta. */
export async function cancelCampaign(c: Campaign, me: Who): Promise<Campaign> {
  const next = await applyAdsEvent(c, "cancel", { approved_by: me.sub });
  await postInThread(next, `✖️ ${whoName(me)} canceló la propuesta #${c.id}. En Meta no se creó nada.`);
  return next;
}

/** [Reintentar] tras un error: vuelve a propuesta para picar «Crear en pausa» otra vez. */
export async function retryCampaign(c: Campaign): Promise<Campaign> {
  return applyAdsEvent(c, "retry", { error: null });
}

/**
 * [Prender] / [Pausar]. Se reclama el estado ANTES de llamar a Meta (dos clics = una
 * llamada) y se regresa si Meta dice que no.
 */
export async function setStatus(c: Campaign, me: Who, to: "ACTIVE" | "PAUSED"): Promise<Campaign> {
  if (!c.metaCampaignId) throw new Error("la campaña todavía no existe en Meta");
  const claimed = await applyAdsEvent(c, to === "ACTIVE" ? "activate" : "pause", { approved_by: me.sub });
  const r = await gsAds("set_status", { campaignId: c.metaCampaignId, status: to, by: me.sub });
  if (!r.ok) {
    await dbq("UPDATE gt_ads_campaigns SET status = ?, approved_by = ?, updated_at = unixepoch() WHERE id = ? AND status = ?", [
      c.status,
      c.approvedBy,
      c.id,
      claimed.status,
    ]);
    const { refreshRoom } = await import("./factory-runs.server");
    void refreshRoom(c.channelId);
    throw new Error(r.error);
  }
  await postInThread(
    claimed,
    to === "ACTIVE"
      ? `▶️ ${whoName(me)} prendió la campaña #${c.id}: gasta hasta ${mxn(c.proposal.dailyBudget)} al día.`
      : `⏸️ ${whoName(me)} pausó la campaña #${c.id}. Deja de gastar.`,
  );
  return claimed;
}

/** [Cambiar presupuesto]: el diario en pesos. */
export async function setBudget(c: Campaign, me: Who, dailyBudget: number): Promise<Campaign> {
  const amount = Math.round(Number(dailyBudget) * 100) / 100;
  const bad = budgetRejection(amount);
  if (bad) throw new Error(bad);
  if (!c.metaCampaignId) throw new Error("la campaña todavía no existe en Meta");
  if (nextAdsStatus(c.status, "budget") == null) throw new Error(`la campaña #${c.id} está «${adsStatusLabel(c.status)}»: su presupuesto ya no se cambia`);
  const r = await gsAds("set_budget", { campaignId: c.metaCampaignId, dailyBudget: amount, by: me.sub });
  if (!r.ok) throw new Error(r.error);
  const before = c.proposal.dailyBudget;
  const next = await applyAdsEvent(c, "budget", {
    approved_by: me.sub,
    proposal_json: JSON.stringify({ ...c.proposal, dailyBudget: amount }),
  });
  await postInThread(next, `💰 ${whoName(me)} cambió el presupuesto de la campaña #${c.id}: ${mxn(before)} → **${mxn(amount)} al día**.`);
  return next;
}

// ── Números: insights de Meta + leads del tablero ────────────────────────────

/**
 * El embudo de cada campaña que existe en Meta: gasto y mensajes (insights) y leads y
 * calificados del tablero de Ventas (`lead_stats` por los ids de sus anuncios). Una sola
 * llamada de cada tipo para todas. Lo que falle queda en `error` y el resto se pinta.
 */
export async function funnels(cs: Campaign[]): Promise<{ byId: Map<number, Funnel>; error: string | null }> {
  const byId = new Map<number, Funnel>();
  const live = cs.filter((c) => c.metaCampaignId);
  if (!live.length) return { byId, error: null };
  const adIds = [...new Set(live.flatMap((c) => c.adIds))];
  const [ins, leads] = await Promise.all([
    gsAds("insights", { campaignIds: live.map((c) => c.metaCampaignId!) }),
    adIds.length ? gsAds("lead_stats", { adIds }) : Promise.resolve(null),
  ]);
  for (const c of live) {
    const i = ins.ok ? ins.byCampaign?.[c.metaCampaignId!] : undefined;
    let l = 0;
    let q = 0;
    if (leads?.ok)
      for (const ad of c.adIds) {
        l += Number(leads.byAd?.[ad]?.leads ?? 0);
        q += Number(leads.byAd?.[ad]?.qualified ?? 0);
      }
    byId.set(c.id, funnelOf({ spend: i?.spend, conversations: i?.conversations, leads: l, qualified: q }));
  }
  const error = !ins.ok ? ins.error : leads && !leads.ok ? leads.error : null;
  return { byId, error };
}

// ── Importar una campaña que ya existe en Meta ───────────────────────────────

/** Estado de Meta → estado nuestro. Lo que no está activo ni pausado ya terminó. */
export function statusFromMeta(s: string): AdsStatus {
  const u = String(s ?? "").toUpperCase();
  if (u === "ACTIVE") return "active";
  if (u === "PAUSED") return "paused";
  return "ended";
}

/** Crea la fila `imported=1` sin tocar Meta. Una campaña se importa una sola vez. */
export async function importCampaign(g: GsCampaign, channelId: number, sub: string): Promise<Campaign> {
  const dup = await dbq("SELECT id FROM gt_ads_campaigns WHERE meta_campaign_id = ?", [g.id]);
  if (dup[0]) throw new Error(`esa campaña ya está importada como #${dup[0].id}`);
  const proposal = { name: g.name, dailyBudget: g.dailyBudget ?? 0, endTime: g.endTime ?? "" } as StoredProposal;
  const rows = await dbq(
    `INSERT INTO gt_ads_campaigns (channel_id, title, status, proposal_json, meta_campaign_id, meta_ad_id, ad_ids, requested_by, imported)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1) RETURNING *`,
    [channelId, g.name.slice(0, 120), statusFromMeta(g.status), JSON.stringify(proposal), g.id, g.adIds[0] ?? null, JSON.stringify(g.adIds ?? []), sub],
  );
  const c = toCampaign(rows[0]);
  const users = await import("../../users.server").then((u) => u.listWorkspaceUsers()).catch(() => []);
  const name = users.find((u) => u.sub === sub)?.name ?? "Alguien";
  // Top-level en el room: el aviso es la raíz del hilo de la campaña y su tarjeta cuelga de ahí.
  const root = await postAsAds(channelId, null, `📥 ${name} importó la campaña de Meta «${g.name}» como **#${c.id}** (${adsStatusLabel(c.status).toLowerCase()}). No se cambió nada en Meta.`);
  if (root) await dbq("UPDATE gt_ads_campaigns SET root_msg_id = ? WHERE id = ?", [root, c.id]);
  const withRoot = (await getCampaign(c.id))!;
  await ensureCampaignCard(withRoot);
  return withRoot;
}
