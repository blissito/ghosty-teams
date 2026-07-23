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

/** Base del runtime nativo, o null si el cutover no está activado (→ EasyBits). */
export function nativeRuntimeBase(): string | null {
  const u = process.env.GHOSTY_RUNTIME_URL?.trim();
  return u ? u.replace(/\/+$/, "") : null;
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
