// Límite de turnos por CONTACTO en un canal público de WhatsApp.
//
// Molde: `src/server/forms/rate.server.ts` — misma mecánica (ventana en la DB del tenant,
// no en memoria: un contador in-process no sobrevive un deploy ni sirve con dos procesos).
// La clave aquí no es una IP sino el teléfono, que en WhatsApp es una identidad mucho más
// fuerte: Meta ya lo verificó.
//
// Qué protege, y no es sólo la factura: un número de WhatsApp Business es un activo que se
// puede perder sin apelación efectiva si Meta lo marca. Un bot que contesta en bucle a un
// flood es exactamente el comportamiento que lo provoca.
//
// ⚠️ Un mensaje bloqueado NO se descarta: se guarda en el room igual. Lo único que no pasa
// es despertar al agente. Perder el mensaje de un cliente sería peor que el abuso.

/** Ráfaga corta y techo diario, como el limitador público de nanoclaw. */
const BURST = { windowS: 60, max: 8 };
const DAILY = { windowS: 86_400, max: 200 };

async function bump(
  key: string,
  windowS: number,
  max: number,
): Promise<{ count: number; allowed: boolean }> {
  const { dbq, num } = await import("../../dbq.server");
  const windowStart = Math.floor(Date.now() / 1000 / windowS) * windowS;
  const rows = await dbq(
    `INSERT INTO gt_wa_rate (bucket, window_start, count) VALUES (?,?,1)
     ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1
     RETURNING count`,
    [`${windowS}:${key}`, windowStart],
  );
  const count = num(rows[0]?.count);
  // Limpieza oportunista: sin cron y sin una tabla que crezca sola.
  if (count === 1) {
    await dbq(`DELETE FROM gt_wa_rate WHERE window_start < ?`, [
      windowStart - windowS * 3,
    ]).catch(() => []);
  }
  return { count, allowed: count <= max };
}

/**
 * ¿Este contacto puede provocar un turno ahora?
 *
 * ⚠️ Un bloqueado **no incrementa** el contador: si contara, alguien que insiste extendería
 * su propio bloqueo indefinidamente. Es la lección explícita del limitador de nanoclaw.
 */
export async function waTurnAllowed(convKey: string): Promise<boolean> {
  try {
    // El diario se consulta primero y en modo lectura: si ya está bloqueado por ráfaga, no
    // hay por qué gastarle cuota del día.
    const burst = await bump(convKey, BURST.windowS, BURST.max);
    if (!burst.allowed) return false;
    const daily = await bump(convKey, DAILY.windowS, DAILY.max);
    return daily.allowed;
  } catch (e) {
    // Fail-open, igual que en formularios: un contador roto no puede dejar mudo al negocio.
    console.error("[wa rate] falló", e);
    return true;
  }
}
