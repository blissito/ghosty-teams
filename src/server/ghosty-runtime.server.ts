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

/**
 * Headers de partner firmados sobre `rawBody`, con el WORKSPACE dentro del
 * canonical (`${ts}.${workspaceNs}.${rawBody}`).
 *
 * El workspace va firmado porque el secreto es uno solo para toda la plataforma:
 * sin él, una firma válida sólo probaba "alguien tiene el secreto", y Studio
 * tenía que creerle al `ownerUserId` que le mandáramos en el body. Ahora Studio
 * resuelve el dueño desde su propia tabla de workspaces. El namespace no es
 * secreto; lo que lo hace confiable es ir dentro de la firma.
 *
 * Es síncrona a propósito: el namespace se resuelve una vez arriba (es una
 * lectura async del tenant) y se pasa, para que esto pueda usarse dentro de un
 * `headers()` sin contagiar de async a toda la cadena.
 */
export function partnerHeaders(rawBody: string, workspaceNs: string): Record<string, string> {
  const secret = process.env.GHOSTY_PARTNER_SECRET;
  if (!secret) throw new Error("GHOSTY_PARTNER_SECRET no configurado");
  if (!workspaceNs) throw new Error("partnerHeaders: falta el namespace del workspace");
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`${ts}.${workspaceNs}.${rawBody}`)
    .digest("hex");
  return {
    "Content-Type": "application/json",
    "x-ghosty-ts": ts,
    "x-ghosty-ws": workspaceNs,
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

/** Lo que Studio contesta cuando un turno no puede correr. `message` viene ya en español
 *  y listo para que el agente lo diga: el texto lo arma `turnGate`, que es quien sabe si
 *  la bolsa es propia o compartida y con cuántos. */
export type TurnDenial = {
  error: "trial_expired" | "quota_exhausted" | string;
  message: string;
  used?: number;
  included?: number;
  resetsAt?: string;
  paidUntil?: string;
};

/**
 * ¿Puede correr este turno? Sólo hace falta preguntarlo para los agentes **ACP**.
 *
 * ⚠️ La asimetría es real y conviene entenderla: un agente nativo manda su turno POR
 * Studio, así que Studio ya lo gatea de camino (`denyIfOutOfQuota` en las rutas de
 * mensaje). Uno ACP habla por WebSocket DIRECTO con su caja —Studio no está en el
 * camino— así que sin esta llamada su bolsa se mide y no corta nunca.
 *
 * La decisión NO se replica aquí: vive en `bagVerdict`, sobre datos que sólo tiene
 * Studio. Dos entradas al mismo turno con reglas distintas es como se cuela un bypass.
 *
 * Ante cualquier fallo devuelve `null` (adelante). Un medidor caído no puede dejar mudo
 * a un agente: el error que se ve es el turno que no salió, no el gate que no respondió.
 */
export async function turnDenial(fleetAgentId: string): Promise<TurnDenial | null> {
  try {
    const base = await nativeRuntimeBase();
    if (!base) return null;
    const { currentNamespace } = await import("./tenant.server");
    const res = await fetch(`${base}/api/v2/fleet-agents/${encodeURIComponent(fleetAgentId)}/gate`, {
      method: "POST",
      headers: partnerHeaders("", await currentNamespace()),
      body: "",
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status !== 402) return null;
    return (await res.json()) as TurnDenial;
  } catch {
    return null;
  }
}
