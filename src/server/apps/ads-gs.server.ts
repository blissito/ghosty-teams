// Cliente de la API de partner de gs para Ghosty Ads (`POST /api/v2/partners/meta-ads`).
//
// gs guarda la credencial de Meta (cifrada, por espacio) y es el único que habla con la
// Marketing API; Teams sólo firma con el workspace de ESTE host, igual que
// `room-sales-board.ts`. Contrato: ghosty-studio/docs/claude/ghosty-ads-app.md.
//
// Nunca lanza: devuelve `{ ok: false, error }` con un error en español que se puede enseñar
// tal cual (a la persona en la tarjeta, o al modelo en una tool).
import type { Proposal, Targeting } from "./ads-proposal";

export type GsResult<T> = ({ ok: true } & T) | { ok: false; error: string };

export type MetaStatus = {
  connected: boolean;
  /** Cuándo vence el token de Meta (ISO) o null si no vence / no se sabe. */
  expiresAt: string | null;
  adAccount: { id: string; name: string; currency: string } | null;
  page: { id: string; name: string } | null;
};

export type GsInsights = { spend: number; impressions: number; clicks: number; conversations: number };
export type GsLeadStats = { byAd: Record<string, { leads: number; qualified: number }>; leads: number; qualified: number };
export type GsCampaign = { id: string; name: string; status: string; dailyBudget: number | null; endTime: string | null; adIds: string[] };

type Ops = {
  status: [Record<string, never>, MetaStatus];
  // `returnTo` tiene que ser https y de *.ghosty.studio (gs lo valida); `email` = quien conecta.
  connect_url: [{ returnTo: string; email?: string | null }, { url: string }];
  assets: [Record<string, never>, { adAccounts: { id: string; name: string; currency: string }[]; pages: { id: string; name: string }[] }];
  select: [{ adAccountId: string; pageId: string }, Record<string, never>];
  interests: [{ q: string }, { items: { id: string; name: string; audienceMin: number; audienceMax: number; path: string[] }[] }];
  estimate: [{ targeting: Targeting }, { lower: number; upper: number }];
  // En video Meta no da iframe: viene `note` para enseñarla en su lugar.
  preview: [{ proposal: Proposal }, { iframeSrc: string | null; note: string | null }];
  campaigns: [Record<string, never>, { items: GsCampaign[] }];
  insights: [{ campaignIds: string[] }, { byCampaign: Record<string, GsInsights> }];
  lead_stats: [{ adIds: string[] }, GsLeadStats];
  create_paused: [{ proposal: Proposal; requestedBy: string }, { campaignId: string; adsetId: string; adId: string }];
  set_status: [{ campaignId: string; status: "ACTIVE" | "PAUSED"; by: string }, Record<string, never>];
  set_budget: [{ campaignId: string; dailyBudget: number; by: string }, Record<string, never>];
};

export type AdsOp = keyof Ops;

export async function gsAds<K extends AdsOp>(op: K, args: Ops[K][0] = {} as Ops[K][0]): Promise<GsResult<Ops[K][1]>> {
  try {
    const { nativeRuntimeBase, partnerHeaders } = await import("../ghosty-runtime.server");
    const { currentNamespace } = await import("../tenant.server");
    const base = await nativeRuntimeBase();
    if (!base) return { ok: false, error: "este espacio no está conectado a Ghosty Studio" };
    const body = JSON.stringify({ op, ...args });
    const res = await fetch(`${base}/api/v2/partners/meta-ads`, {
      method: "POST",
      headers: partnerHeaders(body, await currentNamespace()),
      body,
      signal: AbortSignal.timeout(op === "create_paused" ? 120_000 : 30_000),
    });
    const j = (await res.json().catch(() => null)) as ({ ok?: boolean; error?: string } & Record<string, unknown>) | null;
    if (res.status === 404 && !j?.error) return { ok: false, error: "Ghosty Studio todavía no tiene la conexión con Meta Ads" };
    if (!j) return { ok: false, error: `Ghosty Studio no contestó bien (${res.status})` };
    if (!res.ok || j.ok === false) return { ok: false, error: String(j.error ?? `error ${res.status}`) };
    return { ...(j as object), ok: true } as GsResult<Ops[K][1]>;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: /timeout|aborted/i.test(msg) ? "Meta tardó demasiado en contestar; inténtalo otra vez" : `no pude hablar con Ghosty Studio: ${msg}` };
  }
}

/** Estado de la conexión con Meta; desconectado si gs no contesta (la UI no se rompe). */
export async function metaStatus(): Promise<MetaStatus & { error?: string }> {
  const r = await gsAds("status");
  if (!r.ok) return { connected: false, expiresAt: null, adAccount: null, page: null, error: r.error };
  return { connected: !!r.connected, expiresAt: r.expiresAt ?? null, adAccount: r.adAccount ?? null, page: r.page ?? null };
}
