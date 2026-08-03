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
  const cerrados = new Set<number>();
  // ⚠️ Las escrituras van EN CADENA, nunca sueltas. Con `void write(...)` una escritura podía
  // quedar en vuelo al cerrar el turno y aterrizar DESPUÉS del cuerpo final: resucitaba un
  // body con el fence del documento todavía ABIERTO, y el cliente —que decide por el fence—
  // volvía a abrir el panel y a "reescribir" un documento ya entregado. Visto en vivo el
  // 2026-08-03, y es un bug que sólo existe desde que persistimos a media escritura.
  let chain: Promise<void> = Promise.resolve();

  const write = async (id: number) => {
    if (cerrados.has(id)) return;
    const body = pending.get(id);
    // NUNCA persistir un body vacío: deepseek/ghosty-gc a veces cierra el turno en blanco y
    // guardarlo borraría lo ya streameado. Es la misma red que ya protege el body final.
    if (!body || !body.trim()) return;
    if (written.get(id) === body) return;
    written.set(id, body);
    lastAt.set(id, Date.now());
    // Best-effort de verdad: una escritura fallida no puede tumbar el turno del agente.
    await db.setMessageBodyStreaming(id, body).catch(() => {});
  };

  const encolar = (id: number) => {
    chain = chain.then(() => write(id)).catch(() => {});
    return chain;
  };

  return {
    /** Cada re-pintado del turno pasa por aquí. Escribe como mucho una vez por intervalo. */
    offer(id: number, body: string) {
      if (cerrados.has(id)) return;
      pending.set(id, body);
      if (Date.now() - (lastAt.get(id) ?? 0) < intervalMs) return;
      void encolar(id);
    },
    /**
     * Cierre del turno: guarda lo último pintado y **deja de escribir para siempre** en ese
     * mensaje. Espera a la cadena, así que al volver no queda ninguna escritura en vuelo que
     * pueda pisar el cuerpo final que chat.ts está a punto de escribir.
     */
    async flush(id: number) {
      await encolar(id);
      cerrados.add(id);
      await chain.catch(() => {});
    },
    /** Fin del turno — que los Map no crezcan con los mensajes ya cerrados. */
    done(id: number) {
      pending.delete(id);
      lastAt.delete(id);
      written.delete(id);
    },
  };
}
