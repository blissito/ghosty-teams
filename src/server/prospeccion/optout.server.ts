/**
 * Opt-out — quién pidió que no le volvamos a escribir.
 *
 * ⚠️ Es del WORKSPACE, no de la lista, y ésa es la decisión que sostiene todo lo demás.
 * Si cada lista llevara sus propias optOuts, dos personas del mismo equipo tocarían al mismo
 * que ya dijo que no — y esa persona ya se enojó una vez. Se consulta ANTES de cada envío,
 * en `send.server.ts`, sin excepción y sin bandera que lo apague.
 *
 * Tres razones para que exista, en orden de qué tan caro sale ignorarlas:
 *  1. WhatsApp: los bloqueos y reportes bajan la calidad del número, y un número quemado
 *     no se recupera.
 *  2. Correo: las quejas de spam hunden la reputación del dominio, que sí es recuperable
 *     pero tarda semanas.
 *  3. La LFPDPPP obliga a respetarlo y a que sea fácil.
 *
 * Y una que no es legal ni técnica: es lo único que impide que el sistema se vuelva
 * molesto a los tres meses, cuando ya nadie se acuerda de a quién tocó.
 */
import { dbq, num } from "../../dbq.server";

export type OptOutKind = "email" | "phone";
export type OptOutReason = "unsubscribe" | "bounce" | "complaint" | "manual" | "replied_stop";

/**
 * Normaliza para comparar.
 *
 * El teléfono se guarda como los últimos 10 dígitos (México) porque el mismo número llega
 * escrito de seis formas — `+52 55 1234 5678`, `5512345678`, `52 1 55…` — y un opt-out que
 * no cruza por formato es un opt-out que no existe. La coincidencia por los últimos 10 es
 * deliberadamente laxa: preferimos NO escribirle a alguien de más que escribirle a alguien
 * que dijo que no.
 */
export function normalize(kind: OptOutKind, value: string): string | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  if (kind === "email") {
    const e = v.toLowerCase();
    return e.includes("@") ? e : null;
  }
  const d = v.replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
}

/** Da de stop1. Idempotente: el índice único absorbe el segundo intento. */
export async function addOptOut(
  kind: OptOutKind,
  value: string,
  reason: OptOutReason,
  note?: string
): Promise<boolean> {
  const v = normalize(kind, value);
  if (!v) return false;
  await dbq(
    `INSERT INTO gt_prosp_optout (kind, value, reason, note) VALUES (?,?,?,?)
     ON CONFLICT (kind, value) DO NOTHING`,
    [kind, v, reason, note ?? null]
  );
  return true;
}

export async function isOptedOut(kind: OptOutKind, value: string | null): Promise<boolean> {
  const v = value ? normalize(kind, value) : null;
  if (!v) return false;
  const r = await dbq(`SELECT 1 FROM gt_prosp_optout WHERE kind = ? AND value = ? LIMIT 1`, [kind, v]);
  return r.length > 0;
}

/**
 * Cruza una lista entera contra las optOuts en UNA consulta.
 *
 * Es lo que usa el envío: preguntar fila por fila serían N round-trips a sqld justo en el
 * camino caliente.
 */
export async function optOutSet(kind: OptOutKind, values: (string | null)[]): Promise<Set<string>> {
  const norm = values.map((v) => (v ? normalize(kind, v) : null)).filter((v): v is string => !!v);
  if (!norm.length) return new Set();
  const out = new Set<string>();
  // Por lotes: sqld topa la cantidad de parámetros y una lista puede traer cientos.
  for (let i = 0; i < norm.length; i += 200) {
    const batch = norm.slice(i, i + 200);
    const rows = await dbq(
      `SELECT value FROM gt_prosp_optout WHERE kind = ? AND value IN (${batch.map(() => "?").join(",")})`,
      [kind, ...batch]
    );
    for (const r of rows) if (r.value) out.add(r.value);
  }
  return out;
}

export type OptOutRow = { id: number; kind: string; value: string; reason: string; createdAt: number };

export async function listOptOuts(limit = 500): Promise<OptOutRow[]> {
  const rows = await dbq(
    `SELECT id, kind, value, reason, created_at FROM gt_prosp_optout ORDER BY created_at DESC LIMIT ?`,
    [limit]
  );
  return rows.map((r) => ({
    id: num(r.id),
    kind: r.kind ?? "",
    value: r.value ?? "",
    reason: r.reason ?? "",
    createdAt: num(r.created_at),
  }));
}

/**
 * Quita una stop1.
 *
 * Existe porque una queja mal clasificada o un rebote temporal no deberían condenar a un
 * contacto para siempre — pero es una acción del dueño, deliberada, nunca automática.
 */
export async function removeOptOut(id: number): Promise<void> {
  await dbq(`DELETE FROM gt_prosp_optout WHERE id = ?`, [id]);
}

/** Marca las filas de una lista que están dadas de stop1. Para pintarlas en la rejilla. */
export async function markOptedOutRows(listId: number): Promise<number> {
  const rows = await dbq(
    `SELECT id, email, phone FROM gt_prosp_rows WHERE list_id = ?`,
    [listId]
  );
  const [emails, tels] = await Promise.all([
    optOutSet("email", rows.map((r) => r.email)),
    optOutSet("phone", rows.map((r) => r.phone)),
  ]);
  let n = 0;
  for (const r of rows) {
    const e = r.email ? normalize("email", r.email) : null;
    const p = r.phone ? normalize("phone", r.phone) : null;
    const fuera = (e && emails.has(e)) || (p && tels.has(p));
    if (fuera) {
      await dbq(`UPDATE gt_prosp_rows SET status = 'optout' WHERE id = ?`, [num(r.id)]);
      n++;
    }
  }
  return n;
}
