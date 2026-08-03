import * as db from "../db.server";

/**
 * Persistencia INCREMENTAL del cuerpo de un mensaje mientras el agente escribe.
 *
 * El problema que resuelve: hasta el 2026-08-03 el cuerpo sólo se escribía al TERMINAR el
 * turno (`setMessageBody` en chat.ts). Durante el streaming todo vivía en el cliente
 * (`flowCache`/`threadCache`), y el bus es fire-and-forget sin buffer — así que un refresh,
 * cerrar la pestaña o el PWA reciclando dejaba una cáscara muda: sin texto, sin lista de
 * herramientas y sin borrador en el panel, aunque el worker siguiera trabajando. Con un
 * motor lento y un escrito largo esa ventana son MINUTOS.
 *
 * `setMessageBody` es un UPDATE de una sola columna, sin `edited_at` ni versión ni lock, así
 * que llamarla N veces por turno es seguro y barato. Su propio comentario ya decía que el
 * body autoritativo es lo que habilita el catch-up por cursor; simplemente nadie lo escribía
 * hasta el final.
 *
 * ⚠️ Lo que se ofrece aquí tiene que ser SIEMPRE lo que produce `paint()` (agents.server.ts),
 * nunca un buffer crudo: `extractToolState` exige el fence cerrado y `stripToolBlock` con un
 * fence abierto descarta todo lo que venga después. `paint()` re-pinta el bloque completo y
 * cerrado en cada chunk, así que guardar su salida siempre deja la DB en un estado parseable.
 */
export function makeBodyFlusher(intervalMs = 2000) {
  const pending = new Map<number, string>();
  const lastAt = new Map<number, number>();
  const written = new Map<number, string>();
  let inflight = false;

  const write = async (id: number) => {
    const body = pending.get(id);
    // NUNCA persistir un body vacío: deepseek/ghosty-gc a veces cierra el turno en blanco y
    // guardarlo borraría lo ya streameado. Es la misma red que ya protege el body final.
    if (!body || !body.trim()) return;
    if (written.get(id) === body) return;
    written.set(id, body);
    lastAt.set(id, Date.now());
    // Best-effort de verdad: una escritura fallida no puede tumbar el turno del agente.
    await db.setMessageBody(id, body).catch(() => {});
  };

  return {
    /** Cada re-pintado del turno pasa por aquí. Escribe como mucho una vez por intervalo. */
    offer(id: number, body: string) {
      pending.set(id, body);
      if (inflight) return;
      if (Date.now() - (lastAt.get(id) ?? 0) < intervalMs) return;
      inflight = true;
      void write(id).finally(() => {
        inflight = false;
      });
    },
    /** Cierre del turno: guarda lo último pintado aunque no haya pasado el intervalo. */
    async flush(id: number) {
      await write(id);
    },
    /** Fin del turno — que el Map no crezca con los mensajes ya cerrados. */
    done(id: number) {
      pending.delete(id);
      lastAt.delete(id);
      written.delete(id);
    },
  };
}
