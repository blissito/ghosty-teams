// Transmitir en vivo (YouTube / página de Facebook) por gs: `POST /api/v2/partners/live` con la
// firma de partner del espacio. Mismo patrón que `gsAdsRaw` (apps/ads-gs.server.ts): nunca lanza,
// regresa `{ ok:false, error }` para que la UI enseñe el motivo. Ficha de gs:
// docs/claude/transmitir-en-vivo.md
export type LiveProvider = "youtube" | "facebook";
export type LiveDest = { provider: LiveProvider; account: string; accountId: string; connectedBy: string | null; lastWatchUrl: string | null; lastPreparedAt: string | null };
export type LiveBox = { count?: number; targets: string[]; ready: boolean } | null;
export type LiveStatus = { configured: Record<LiveProvider, boolean>; destinations: LiveDest[] };
export type LivePrepared = {
  prepared: { provider: LiveProvider; account: string; watchUrl: string }[];
  failed: { provider: LiveProvider; account: string; error: string }[];
  box: { reloaded: boolean; targets: string[]; ready: boolean } | null;
};

type Ops = {
  status: [Record<string, never>, LiveStatus];
  check: [Record<string, never>, { box: LiveBox }];
  connect_url: [{ provider: LiveProvider; returnTo: string; email?: string | null; locale?: string }, { url: string }];
  unlink: [{ provider: LiveProvider; by: string }, Record<string, never>];
  prepare: [{ title: string; description?: string; privacy?: string; startsAt?: string; only?: LiveProvider[]; by: string }, LivePrepared];
};

export type GsLive<T> = ({ ok: true } & T) | { ok: false; error: string };

export async function gsLive<K extends keyof Ops>(op: K, args: Ops[K][0] = {} as Ops[K][0]): Promise<GsLive<Ops[K][1]>> {
  const t0 = Date.now();
  try {
    const { nativeRuntimeBase, partnerHeaders } = await import("../ghosty-runtime.server");
    const { currentNamespace } = await import("../tenant.server");
    const base = await nativeRuntimeBase();
    if (!base) return { ok: false, error: "este espacio no está conectado a Ghosty Studio" };
    const body = JSON.stringify({ op, ...args });
    const res = await fetch(`${base}/api/v2/partners/live`, {
      method: "POST",
      headers: partnerHeaders(body, await currentNamespace()),
      body,
      // Preparar crea los eventos y reinicia la caja de eventos: tarda.
      signal: AbortSignal.timeout(op === "prepare" ? 120_000 : 20_000),
    });
    const j = (await res.json().catch(() => null)) as ({ ok?: boolean; error?: string } & Record<string, unknown>) | null;
    console.log(`[live gs ${op} ${Date.now() - t0}ms] ${res.ok && j?.ok !== false ? "ok" : `error: ${String(j?.error ?? res.status).slice(0, 160)}`}`);
    if (!j) return { ok: false, error: `Ghosty Studio no contestó bien (${res.status})` };
    if (!res.ok || j.ok === false) return { ok: false, error: String(j.error ?? `error ${res.status}`) };
    return { ...(j as object), ok: true } as GsLive<Ops[K][1]>;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: /timeout|aborted/i.test(msg) ? "tardó demasiado; revisa el estado en un momento" : `no pude hablar con Ghosty Studio: ${msg}` };
  }
}
