// Turnos de agente EN VUELO — el registro que hace posible detenerlos y contar la cola.
//
// Hasta ahora un turno era una promesa anónima: nadie sabía cuáles estaban corriendo, así
// que mandar tres mensajes seguidos pintaba tres "pensando…" idénticos (uno corriendo y
// dos esperando el lock del worker) sin forma de cortar ninguno.
//
// Vive EN MEMORIA a propósito: un turno no sobrevive al proceso que lo atiende. Si el
// server se reinicia, sus turnos mueren con él y sus cáscaras quedan huérfanas — eso ya
// pasaba; lo que este registro añade es poder cerrarlas (ver `sweepOrphans`).

export type LiveTurn = {
  messageId: number;
  /** Sesión del worker. Los turnos de un mismo groupId se serializan allá: son LA cola. */
  groupId: string;
  /** Quién lo pidió. Sólo esa persona (o quien pueda administrar) puede detenerlo. */
  invokerSub?: string | null;
  startedAt: number;
  /** Corta el fetch al worker. Colgar la conexión es lo que detiene el turno de verdad. */
  controller: AbortController;
  /** Para avisar a los clientes al cambiar de estado, sin acoplar este módulo al bus. */
  announce?: (state: TurnState) => void;
  stopped?: boolean;
};

export type TurnState = {
  id: number;
  state: "running" | "queued" | "stopped";
  /** Posición en la cola (1 = el que corre). Deja de ser N burbujas indistinguibles. */
  position: number;
  startedAt: number;
};

const live = new Map<number, LiveTurn>();

/** Los del mismo groupId, del más viejo al más nuevo: el orden REAL en que se atienden. */
function siblings(groupId: string): LiveTurn[] {
  return [...live.values()]
    .filter((t) => t.groupId === groupId)
    .sort((a, b) => a.startedAt - b.startedAt || a.messageId - b.messageId);
}

function stateOf(t: LiveTurn): TurnState {
  const pos = siblings(t.groupId).findIndex((x) => x.messageId === t.messageId) + 1;
  return {
    id: t.messageId,
    state: t.stopped ? "stopped" : pos <= 1 ? "running" : "queued",
    position: Math.max(1, pos),
    startedAt: t.startedAt,
  };
}

/** Re-anuncia a TODOS los del grupo: cuando uno termina, los de atrás avanzan de lugar. */
function announceGroup(groupId: string): void {
  for (const t of siblings(groupId)) t.announce?.(stateOf(t));
}

export function registerTurn(t: Omit<LiveTurn, "startedAt"> & { startedAt?: number }): LiveTurn {
  const entry: LiveTurn = { ...t, startedAt: t.startedAt ?? Date.now() };
  live.set(entry.messageId, entry);
  announceGroup(entry.groupId);
  return entry;
}

export function finishTurn(messageId: number): void {
  const t = live.get(messageId);
  if (!t) return;
  live.delete(messageId);
  announceGroup(t.groupId);
}

export function turnState(messageId: number): TurnState | null {
  const t = live.get(messageId);
  return t ? stateOf(t) : null;
}

/** Estado de todos los turnos vivos de un canal/DM — para sembrar al cargar la vista. */
export function liveTurnStates(messageIds: number[]): TurnState[] {
  return messageIds.map((id) => turnState(id)).filter((s): s is TurnState => !!s);
}

/**
 * TODOS los turnos vivos del proceso. Para sembrar el cliente al montar.
 *
 * Sin esto, el mapa `turns` del cliente se alimenta ÚNICAMENTE del evento SSE `turn`, así
 * que tras un refresh queda vacío: el cronómetro y el botón Detener desaparecen y un turno
 * que sigue corriendo se ve idéntico a uno terminado. Es lo que hizo leer "ya acabó" y
 * "está atorado" sobre turnos que iban perfectamente (2026-08-03).
 *
 * No filtra por canal a propósito: el cliente sólo mira los ids que tiene en pantalla, y
 * filtrar aquí exigiría pasear la lista de mensajes para algo que cabe en un puñado de
 * entradas.
 */
export function allLiveTurnStates(): TurnState[] {
  return [...live.keys()].map((id) => turnState(id)).filter((s): s is TurnState => !!s);
}

/**
 * Detiene un turno. Cortar el fetch cuelga la conexión con el worker, y el worker
 * (desde 2026-07-28) cierra su generador al detectarlo: suelta el lock de la sesión y
 * el siguiente de la cola arranca. Sin ese cambio del worker, esto sólo dejaría de
 * escuchar y la cola seguiría tapada.
 *
 * Devuelve false si el turno ya no existe — detener algo que acaba de terminar no es
 * un error, es una carrera normal entre el clic y el último token.
 */
export function stopTurn(messageId: number, bySub?: string | null): boolean {
  const t = live.get(messageId);
  if (!t) return false;
  // Sólo quien lo pidió lo detiene. En un canal cualquiera ve la burbuja, y cortar el
  // trabajo que otro pidió es una acción sobre esa persona, no sobre el agente.
  if (t.invokerSub && bySub && t.invokerSub !== bySub) return false;
  t.stopped = true;
  t.controller.abort();
  t.announce?.(stateOf(t));
  // ⚠️ Red contra ZOMBIS. `abort()` corta el fetch, y normalmente el `.finally()` del turno
  // llama a `finishTurn` y la entrada se va. Pero si la conexión con el worker está colgada
  // —el caso en el que más falta hace Detener— ese finally puede no llegar nunca, y entonces
  // el turno se queda registrado para siempre: "Detener" parece no hacer nada y la fila no
  // desaparece (2026-08-03). A los 5s se retira a la fuerza.
  const id = t.messageId;
  const grupo = t.groupId;
  setTimeout(() => {
    const sigue = live.get(id);
    if (sigue && sigue.stopped) {
      live.delete(id);
      announceGroup(grupo);
    }
  }, 5000).unref?.();
  return true;
}

/**
 * ¿Tengo YO un turno corriendo en este flow? Es la condición del STEER: mi mensaje nuevo
 * se mete al turno vivo (el worker lo empuja a la misma sesión del SDK) en vez de matarlo.
 * El de otra persona no cuenta: el canal es compartido, ese trabajo no es mío.
 */
export function hasOwnInflight(groupId: string, invokerSub?: string | null): boolean {
  if (!invokerSub) return false;
  for (const t of siblings(groupId)) if (t.invokerSub === invokerSub && !t.stopped) return true;
  return false;
}

/**
 * Interrupción: el MISMO invocador vuelve a escribir en el mismo flow mientras su turno
 * corre. Casi siempre es una corrección ("mejor en html", "brandeado con fixtergeek") y
 * dejarla en cola la vuelve una respuesta tardía a algo que ya nadie quería.
 *
 * De OTRA persona no se interrumpe: el canal es compartido y el turno no es suyo.
 */
export function interruptOwnTurns(groupId: string, invokerSub?: string | null): number {
  if (!invokerSub) return 0;
  let n = 0;
  for (const t of siblings(groupId)) {
    if (t.invokerSub === invokerSub && !t.stopped) {
      stopTurn(t.messageId, invokerSub);
      n++;
    }
  }
  return n;
}

/**
 * Cierra las cáscaras HUÉRFANAS de este namespace. Se llama una vez por tenant al
 * levantar el proceso (desde `ensureSchema`, que es donde sabemos que su tabla existe).
 *
 * El registro de turnos vive en memoria a propósito, así que un reinicio del server se
 * lleva sus turnos y deja sus burbujas en "pensando…" **para siempre**: el cliente espera
 * un `message:body` que ya nunca va a llegar. Detener una a mano ya funcionaba
 * (`stopTurnFn` cierra una cáscara vacía sin turno vivo), pero eso obliga a la persona a
 * limpiar el desorden de un deploy — y a adivinar que hay que hacerlo, porque la burbuja
 * se ve igual que un turno que sí está trabajando.
 *
 * Un turno no sobrevive al proceso, así que al arrancar NADA está en vuelo y toda cáscara
 * vacía es basura. El margen de 60s es contra la carrera del arranque: si alguien postea
 * justo mientras esto corre, su turno legítimo no se toca.
 */
export async function sweepOrphans(): Promise<number> {
  try {
    const { dbq } = await import("../dbq.server");
    // `agent_handle IS NOT NULL` = la cáscara la creó un turno de agente. Un mensaje de
    // persona con body vacío no existe (postMessage lo rechaza), pero acotarlo igual
    // evita tocar cualquier otra fila que algún día nazca vacía.
    // ⚠️ DOS formas de quedar huérfano, y la segunda nació el 2026-08-03 con la
    // persistencia incremental: antes una cáscara abandonada estaba VACÍA, y desde que el
    // cuerpo se guarda mientras el agente escribe, un turno cortado a media respuesta tiene
    // TEXTO — así que este barrido dejaba de reconocerlo y la burbuja se quedaba
    // "trabajando" para siempre. El flag `streaming` es lo que las distingue.
    //
    // Y al huérfano CON texto no se le borra lo escrito: se le añade el aviso. Lo que el
    // agente alcanzó a redactar suele ser la mitad de un documento — tirarlo sería el
    // peor de los dos males.
    await dbq(
      `UPDATE gc_messages SET body = body || ?, streaming = 0
         WHERE streaming = 1 AND created_at < unixepoch() - 60`,
      ["\n\n⏹ _Interrumpido: el servidor se reinició mientras el agente escribía._"],
    ).catch(() => {});
    const rows = await dbq(
      `UPDATE gc_messages SET body = ?
         WHERE agent_handle IS NOT NULL
           AND (body IS NULL OR trim(body) = '')
           AND created_at < unixepoch() - 60
       RETURNING id`,
      ["⏹ Detenido (el servidor se reinició)."],
    );
    const n = rows.length;
    if (n) console.log(`[turns] barrido de arranque: ${n} cáscara(s) huérfana(s) cerrada(s)`);
    return n;
  } catch (e) {
    // Best-effort: esto es limpieza, no puede tumbar el arranque de un tenant.
    console.error("[turns] sweepOrphans falló", e);
    return 0;
  }
}
