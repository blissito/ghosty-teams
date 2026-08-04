// Rate limit de los endpoints públicos de formularios (submit y borradores).
//
// Vive en la DB del tenant y no en memoria: un contador in-process no sobrevive un deploy ni
// sirve con más de un proceso. Cuesta un round-trip por petición, aceptable para un intake.
//
// ⚠️ Sin IP NO hay bypass. El original se SALTABA el límite cuando no podía leerla, o sea
// que bastaba un proxy mal configurado para quedarse sin límite; aquí "unknown" es su propia
// cubeta, y más estrecha.
//
// Vivía dentro de `api.form.$token.ts`. Salió de ahí cuando el endpoint de borradores necesitó
// exactamente lo mismo: dos copias de un limitador divergen, y la que se queda floja es la
// que nadie mira.

export type RateOpts = {
  /** Prefijo de la cubeta: separa el presupuesto de submit del de borradores. */
  scope?: string;
  windowS?: number;
  maxWithIp?: number;
  maxNoIp?: number;
};

const DEFAULTS = { windowS: 60, maxWithIp: 10, maxNoIp: 5 };

export function clientIp(request: Request): string | null {
  const xff = request.headers.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  return first || request.headers.get("cf-connecting-ip") || null;
}

/**
 * Hash de la IP. Nunca en claro: sirve para el límite y para investigar abuso, no para
 * identificar a quien contesta.
 */
export async function hashIp(ip: string | null): Promise<string | null> {
  if (!ip) return null;
  const crypto = await import("node:crypto");
  const salt = process.env.GHOSTY_PARTNER_SECRET ?? "";
  return crypto.createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
}

export async function rateCheck(
  formId: string,
  ip: string | null,
  opts: RateOpts = {}
): Promise<{ ipHash: string | null; allowed: boolean }> {
  const { windowS, maxWithIp, maxNoIp } = { ...DEFAULTS, ...opts };
  const ipHash = await hashIp(ip);
  const bucket = (opts.scope ? `${opts.scope}:` : "") + (ipHash ?? "unknown");
  const max = ipHash ? maxWithIp : maxNoIp;
  const windowStart = Math.floor(Date.now() / 1000 / windowS) * windowS;

  try {
    const { dbq, num } = await import("../../dbq.server");
    const rows = await dbq(
      `INSERT INTO gt_form_rate (form_id, bucket, window_start, count) VALUES (?,?,?,1)
       ON CONFLICT(form_id, bucket, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
      [formId, bucket, windowStart]
    );
    // Limpieza oportunista de ventanas viejas: sin cron, sin tabla que crezca sola.
    if (num(rows[0]?.count) === 1) {
      await dbq(`DELETE FROM gt_form_rate WHERE window_start < ?`, [windowStart - windowS * 10]).catch(() => []);
    }
    return { ipHash, allowed: num(rows[0]?.count) <= max };
  } catch (e) {
    // Un fallo del contador no debe tirar el formulario: se deja pasar y se loguea.
    console.error("[form rate] falló", e);
    return { ipHash, allowed: true };
  }
}
