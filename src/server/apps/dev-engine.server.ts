// Una sola fábrica (bliss, 22-nov): con `devEngine: "unified"` en el espacio, el pedido de un room corre en el motor de
// pendientes de gs (`app/lib/dev-runs`) y el hilo del room es la VISTA de su conversación `dev:<id>`. Teams no decide
// nada del flujo: arranca, lee el estado y le pasa a gs lo que la persona dice en el hilo. La puerta es
// `POST {gs}/internal/dev-runs/:slug?ts&sig` firmada `HMAC(ts.slug.body)` con `GHOSTY_PARTNER_SECRET`.
import crypto from "node:crypto";

const IDP = () => process.env.GHOSTY_IDENTITY_URL ?? "https://www.ghosty.studio";

export type DevEngine = "legacy" | "unified";

/** La firma de la puerta (pura, con su test): la misma de `internal.workspace-*` más el cuerpo. */
export function devRunsSignature(secret: string, ts: number, slug: string, body: string): string {
  return crypto.createHmac("sha256", secret).update(`${ts}.${slug}.${body}`).digest("hex");
}

export type DevRunsReply = { ok: boolean; status: number; data: any };

/** Llama a la puerta. Nunca lanza: `ok:false` con el status y lo que dijo gs. */
export async function devRunsCall(op: string, body: Record<string, unknown> = {}, slug?: string | null): Promise<DevRunsReply> {
  const secret = process.env.GHOSTY_PARTNER_SECRET;
  const s = slug ?? (await (await import("../tenant.server")).currentSlug().catch(() => null));
  if (!secret || !s) return { ok: false, status: 0, data: { error: "sin espacio o sin secreto" } };
  const raw = JSON.stringify({ op, ...body });
  const ts = Math.floor(Date.now() / 1000);
  try {
    const res = await fetch(`${IDP()}/internal/dev-runs/${encodeURIComponent(s)}?ts=${ts}&sig=${devRunsSignature(secret, ts, s, raw)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text.slice(0, 300) };
    }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: (e as Error).message } };
  }
}

// El motor del espacio cambia rara vez (lo prende bliss en `planConfig`): un minuto de caché por espacio.
const engineCache = new Map<string, { at: number; v: DevEngine }>();

/** ¿Este espacio ya corre sus pedidos en gs? Ante cualquier duda, `legacy` (el flujo de siempre no se rompe). */
export async function devEngineOf(slug?: string | null): Promise<DevEngine> {
  const s = slug ?? (await (await import("../tenant.server")).currentSlug().catch(() => null));
  if (!s) return "legacy";
  const hit = engineCache.get(s);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  const r = await devRunsCall("engine", {}, s);
  const v: DevEngine = r.ok && r.data?.engine === "unified" ? "unified" : "legacy";
  engineCache.set(s, { at: Date.now(), v });
  return v;
}
