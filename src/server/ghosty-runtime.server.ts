// ── Cliente del runtime NATIVO de agentes (Teams → Ghosty Studio) ──────────────
// Cutover EasyBits→Studio. Cuando `GHOSTY_RUNTIME_URL` está seteada, los turnos
// de fleet van al runtime co-locado de Studio (mismo host OVH → sub-segundo, sin
// OVH→Fly→OVH) en vez de `www.easybits.cloud`. Auth = firma HMAC de partner
// (GHOSTY_PARTNER_SECRET, la MISMA del IdP) sobre el rawBody → adiós danza de
// refresh del fleet_token (que caducaba). Studio verifica en
// `partner-hmac.server.ts` (canonical `${ts}.${rawBody}`, ventana ±300s).
//
// El vocabulario SSE de salida es IDÉNTICO (`chunk`/`tool`/`done`/`error`) → el
// parser de `agents.server.ts` NO cambia; sólo la URL base + los headers de auth.
//
// El owner del agente lo resuelve Studio desde la fila FleetAgent (por :id), NO
// se manda aquí: el path de mensaje sólo firma y postea.
import crypto from "node:crypto";

/**
 * Base del runtime nativo para el tenant ACTUAL, o null si sigue en EasyBits.
 * Cutover POR-TENANT: la URL vive en `gc_config.agent_runtime_url` del workspace
 * (namespace por request vía dbq) → prendo el nativo en un solo team sin romper a
 * los demás (que siguen en EasyBits). Fallback: env `GHOSTY_RUNTIME_URL` a nivel
 * box (para un flip global futuro). Async porque lee gc_config del tenant.
 */
export async function nativeRuntimeBase(): Promise<string | null> {
  try {
    const { getConfig } = await import("../config.server");
    const perTenant = (await getConfig("agent_runtime_url"))?.trim();
    if (perTenant) return perTenant.replace(/\/+$/, "");
  } catch {
    // sin config/tenant → cae al env global
  }
  const env = process.env.GHOSTY_RUNTIME_URL?.trim();
  return env ? env.replace(/\/+$/, "") : null;
}

/** Headers de partner firmados sobre `rawBody` (x-ghosty-ts + x-ghosty-sig). */
export function partnerHeaders(rawBody: string): Record<string, string> {
  const secret = process.env.GHOSTY_PARTNER_SECRET;
  if (!secret) throw new Error("GHOSTY_PARTNER_SECRET no configurado");
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = crypto.createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  return {
    "Content-Type": "application/json",
    "x-ghosty-ts": ts,
    "x-ghosty-sig": sig,
  };
}

/**
 * Verifica una firma de partner ENTRANTE (runtime nativo → Teams, p.ej. dispatch de tools).
 * Mismo canonical que `partnerHeaders` (`${ts}.${rawBody}`), ventana ±300s anti-replay.
 */
export function verifyPartner(rawBody: string, ts: string | null, sig: string | null): boolean {
  const secret = process.env.GHOSTY_PARTNER_SECRET;
  if (!secret || !ts || !sig) return false;
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Math.floor(Date.now() / 1000) - tsNum) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
