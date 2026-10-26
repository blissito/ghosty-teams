// ── El motivo de un turno caído, dicho para personas ───────────────────────────────────────
//
// La burbuja decía «⚠️ No pude contactar a @x: » + el `e.message` crudo: `fleet-stream 404
// {"error":"turno no existe"}`, «persistent session ended mid-turn», una IP interna
// `172.20.0…` (auditoría 1–26 oct: 18 burbujas así). El mensaje completo se queda en el log y
// en `gt_turns` por `onFailure`; aquí sólo se traduce lo que lee la persona.

const KNOWN: [RegExp, string][] = [
  [/\b40[13]\b|unauthori[sz]ed|forbidden|ticket/i, "no aceptó la credencial del turno"],
  [/\b402\b|saldo|quota|cuota/i, "se quedó sin saldo"],
  [/turno no existe|\b404\b|not found/i, "el turno se perdió de su lado"],
  [/session ended|ECONNRESET|socket hang up|terminated|EPIPE|closed/i, "se cortó la conexión a media respuesta"],
  [/timed? ?out|ETIMEDOUT|deadline/i, "tardó demasiado en responder"],
  [/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|\b5\d\d\b|fetch failed|unavailable/i, "su computadora no respondió"],
];

/** Motivo legible para la burbuja. Nunca deja JSON, IPs ni URLs. */
export function humanAgentError(raw: unknown): string {
  const msg = raw instanceof Error ? raw.message : String(raw ?? "");
  for (const [re, text] of KNOWN) if (re.test(msg)) return text;
  const clean = msg
    .replace(/\{[\s\S]*\}/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean && clean.length <= 140 ? clean : "falló algo de nuestro lado";
}
