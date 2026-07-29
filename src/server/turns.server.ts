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
