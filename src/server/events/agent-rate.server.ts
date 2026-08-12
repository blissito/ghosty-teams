// Tope de turnos de agente en la sala de un evento abierto.
//
// Molde: `src/server/whatsapp/rate.server.ts`, que resuelve exactamente esto para el otro
// canal público. Se reusa la tabla `gt_form_rate` en vez de crear una propia: su forma
// (`form_id`, `bucket`, `window_start`, `count`) ya es un contador genérico con ventana, y
// una tabla nueva costaría migración en todos los tenants para guardar lo mismo.
//
// Qué protege: la FACTURA DEL DUEÑO. No hay enforcement de saldo en ninguna parte del
// sistema, así que sin esto el límite de lo que 100 desconocidos pueden gastarle es su
// paciencia. Un webinar anunciado es, además, el momento perfecto para que alguien lo
// pruebe a propósito.
//
// ⚠️ Un turno bloqueado NO se descarta: el mensaje del invitado se guarda igual y se ve en
// la sala. Lo único que no pasa es que el agente conteste. Perder el mensaje sería peor.

/** Por PERSONA: que nadie acapare el agente delante de los demás. */
const POR_INVITADO = { windowS: 300, max: 5 };
/** Por EVENTO: el techo de la factura, mire quien mire. */
const POR_EVENTO = { windowS: 3600, max: 120 };

async function bump(bucket: string, windowS: number, max: number): Promise<boolean> {
  const { dbq, num } = await import("../../dbq.server");
  const windowStart = Math.floor(Date.now() / 1000 / windowS) * windowS;
  const rows = await dbq(
    `INSERT INTO gt_form_rate (form_id, bucket, window_start, count) VALUES (?,?,?,1)
     ON CONFLICT(form_id, bucket, window_start) DO UPDATE SET count = count + 1
     RETURNING count`,
    ["evtagent", `${windowS}:${bucket}`, windowStart]
  );
  const count = num(rows[0]?.count);
  // Limpieza oportunista: sin cron y sin una tabla que crezca sola.
  if (count === 1) {
    await dbq(`DELETE FROM gt_form_rate WHERE form_id = 'evtagent' AND window_start < ?`, [
      windowStart - windowS * 3,
    ]).catch(() => []);
  }
  return count <= max;
}

/**
 * ¿Puede este invitado provocar un turno del agente ahora?
 *
 * ⚠️ Quien ya está bloqueado **no incrementa** el contador del evento: el corte por persona
 * se comprueba primero y sale sin tocar el presupuesto común. Si no, alguien que insiste se
 * gastaría solo el cupo de toda la sala — que es justo lo que el tope viene a evitar.
 */
export async function eventAgentTurnAllowed(channelId: number, guestSub: string): Promise<boolean> {
  try {
    if (!(await bump(`${channelId}:${guestSub}`, POR_INVITADO.windowS, POR_INVITADO.max))) return false;
    return await bump(`${channelId}`, POR_EVENTO.windowS, POR_EVENTO.max);
  } catch (e) {
    // Fail-open, igual que en formularios y en WhatsApp: un contador roto no puede dejar
    // mudo al agente en mitad de un webinar en vivo.
    console.error("[evento rate] falló", e);
    return true;
  }
}
