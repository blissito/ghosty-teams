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
  /** Workspace al que pertenece. Sin esto, dos tenants comparten espacio de ids. */
  ns: string;
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
  // Contexto para pintar la barra sin volver a consultar la base en cada refresco.
  channelId?: number | null;
  parentId?: number | null;
  /** DM al que pertenece el turno (los DMs no tienen channelId). */
  dmId?: number | null;
  agent?: string;
  avatar?: string;
  /** Lo que pidió la persona, recortado: nombra la fila. */
  tarea?: string;
  /** Último paso narrado por el agente. */
  paso?: string;
};

export type TurnState = {
  id: number;
  state: "running" | "queued" | "stopped" | "done";
  /** Posición en la cola (1 = el que corre). Deja de ser N burbujas indistinguibles. */
  position: number;
  startedAt: number;
  // El evento llevaba sólo id/estado/posición, y por eso el cliente TENÍA que preguntar por
  // el resto cada pocos segundos (2 consultas por turno vivo y por pestaña). Yendo completo,
  // la barra se pinta con lo que llega y el sondeo sobra.
  agent?: string;
  avatar?: string;
  channelId?: number | null;
  parentId?: number | null;
  dmId?: number | null;
  /** Sólo para FILTRAR en el servidor. Se quita antes de mandarlo al cliente. */
  invokerSub?: string | null;
  tarea?: string;
  paso?: string;
  outcome?: string;
};

/**
 * ⚠️ CLAVE COMPUESTA `ns:messageId`, no `messageId` a secas.
 *
 * Un mismo proceso sirve N workspaces y los `message_id` son autoincrementales **por
 * tenant**, así que colisionan entre workspaces. Con la clave pelada pasaban tres cosas, y
 * la primera es de privacidad:
 *
 * 1. `allLiveTurnStates()` devolvía los turnos de TODOS los tenants — y `tarea` es el texto
 *    literal que escribió la persona. La barra de un workspace enseñaba lo que estaba
 *    pidiendo alguien de otro.
 * 2. Registrar el mensaje 42 del tenant B **pisaba** el turno 42 del tenant A: su
 *    `AbortController` se perdía (Detener dejaba de cortar) y el `finishTurn` de A borraba
 *    el turno de B.
 * 3. `stopTurn(42, …)` podía abortar el turno de otro workspace.
 */
const live = new Map<string, LiveTurn>();
const claveDe = (ns: string, messageId: number) => `${ns}:${messageId}`;

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
    agent: t.agent,
    avatar: t.avatar,
    channelId: t.channelId ?? null,
    parentId: t.parentId ?? null,
    dmId: t.dmId ?? null,
    invokerSub: t.invokerSub ?? null,
    tarea: t.tarea,
    paso: t.paso,
  };
}

/** Re-anuncia a TODOS los del grupo: cuando uno termina, los de atrás avanzan de lugar. */
function announceGroup(groupId: string): void {
  for (const t of siblings(groupId)) t.announce?.(stateOf(t));
}

/**
 * Persistencia del turno. Es best-effort A PROPÓSITO: la fila sirve para SABER (sobrevivir a
 * un deploy, cerrar huérfanos, pintar la barra), pero un fallo escribiéndola no puede impedir
 * que el agente trabaje. El mapa en memoria sigue siendo la verdad operativa.
 */
async function persistir(sql: string, args: unknown[]): Promise<void> {
  try {
    const { dbq } = await import("../dbq.server");
    await dbq(sql, args as never[]);
  } catch {
    /* la barra puede mentir un rato; el turno no se cae por esto */
  }
}

export function registerTurn(t: Omit<LiveTurn, "startedAt"> & { startedAt?: number }): LiveTurn {
  const entry: LiveTurn = { ...t, startedAt: t.startedAt ?? Date.now() };
  live.set(claveDe(entry.ns, entry.messageId), entry);
  void persistir(
    `INSERT INTO gt_turns (message_id, group_id, invoker_sub, channel_id, parent_id, agent, avatar, tarea, state, started_at)
     VALUES (?,?,?,?,?,?,?,?,'running',?)
     ON CONFLICT(message_id) DO UPDATE SET state='running', started_at=excluded.started_at, ended_at=NULL, outcome=NULL`,
    [entry.messageId, entry.groupId, entry.invokerSub ?? null, entry.channelId ?? null,
     entry.parentId ?? null, entry.agent ?? null, entry.avatar ?? null, entry.tarea ?? null, entry.startedAt],
  );
  announceGroup(entry.groupId);
  return entry;
}

/** Lo que el turno acabó produciendo, para la fila de "terminó". Se calcula UNA vez. */
export function setTurnOutcome(_ns: string, messageId: number, outcome: string): void {
  void persistir("UPDATE gt_turns SET outcome = ? WHERE message_id = ?", [outcome, messageId]);
}

/** El paso en curso, para que la barra diga en qué va sin preguntar por el cuerpo. */
export function setTurnStep(ns: string, messageId: number, paso: string): void {
  const t = live.get(claveDe(ns, messageId));
  if (!t || t.paso === paso) return;
  t.paso = paso;
  void persistir("UPDATE gt_turns SET paso = ? WHERE message_id = ?", [paso, messageId]);
  t.announce?.(stateOf(t));
}

export function finishTurn(ns: string, messageId: number): void {
  const t = live.get(claveDe(ns, messageId));
  if (!t) return;
  live.delete(claveDe(ns, messageId));
  void persistir("UPDATE gt_turns SET state = ?, ended_at = ? WHERE message_id = ?", [
    t.stopped ? "stopped" : "done",
    Date.now(),
    messageId,
  ]);
  // ⚠️ NO se anuncia "done" aquí. Este `finishTurn` corre en el `.finally()` del turno, que
  // es ANTES de publicar el artefacto: anunciarlo aquí hacía que la barra dijera "terminó"
  // mientras el documento todavía se estaba creando. Lo que sí pasa ya es liberar la cola —
  // el lock del worker está libre y el siguiente puede entrar—, así que eso va inmediato.
  // El "done" lo emite `avisarFinDeTurno` cuando la entrega existe de verdad.
  announceGroup(t.groupId);
}

export function turnState(ns: string, messageId: number): TurnState | null {
  const t = live.get(claveDe(ns, messageId));
  return t ? stateOf(t) : null;
}

/** Estado de todos los turnos vivos de un canal/DM — para sembrar al cargar la vista. */
export function liveTurnStates(ns: string, messageIds: number[]): TurnState[] {
  return messageIds.map((id) => turnState(ns, id)).filter((s): s is TurnState => !!s);
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
export function allLiveTurnStates(ns: string): TurnState[] {
  return [...live.values()].filter((t) => t.ns === ns).map(stateOf);
}

/**
 * Lo que ACABÓ hace poco, leído de `gt_turns`. Es lo que hace que la tabla sirva para algo:
 * sin esto era de sólo escritura, y la barra perdía el historial de entregas en cada
 * recarga o reinicio — justo lo que la persistencia venía a resolver.
 *
 * Sólo `done`: un turno detenido o interrumpido no es una entrega y no merece una fila con
 * palomita.
 */
export async function recentDoneTurns(ns: string, desdeMs = 10 * 60 * 1000): Promise<TurnState[]> {
  try {
    const { dbq } = await import("../dbq.server");
    const filas = await dbq(
      `SELECT message_id, agent, avatar, channel_id, parent_id, invoker_sub, tarea, outcome, started_at
         FROM gt_turns
        WHERE state = 'done' AND ended_at IS NOT NULL AND ended_at > ?
        ORDER BY ended_at DESC LIMIT 20`,
      [Date.now() - desdeMs],
    );
    // ⚠️ La tabla es del TENANT (cada workspace tiene su base), así que no hace falta
    // filtrar por `ns` aquí — pero el parámetro se queda porque el llamador sí lo tiene y
    // deja explícito de quién es lo que se devuelve.
    void ns;
    return filas.map((f) => ({
      id: Number(f.message_id),
      state: "done" as const,
      position: 1,
      startedAt: Number(f.started_at ?? 0),
      agent: (f.agent as string) ?? "",
      avatar: (f.avatar as string) ?? "",
      channelId: f.channel_id != null ? Number(f.channel_id) : null,
      parentId: f.parent_id != null ? Number(f.parent_id) : null,
      dmId: null,
      invokerSub: (f.invoker_sub as string) ?? null,
      tarea: (f.tarea as string) ?? undefined,
      outcome: (f.outcome as string) ?? undefined,
    }));
  } catch {
    return [];
  }
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
export function stopTurn(ns: string, messageId: number, bySub?: string | null): boolean {
  const t = live.get(claveDe(ns, messageId));
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
  const clave = claveDe(ns, t.messageId);
  const grupo = t.groupId;
  setTimeout(() => {
    const sigue = live.get(clave);
    if (sigue && sigue.stopped) {
      live.delete(clave);
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
      stopTurn(t.ns, t.messageId, invokerSub);
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
    // Los turnos que otro proceso dejó `running` son huérfanos POR DEFINICIÓN: un turno no
    // sobrevive al proceso que lo atiende, así que al arrancar nada está realmente en vuelo.
    // Esto convierte el barrido de heurística en hecho — antes tenía que adivinar por
    // "cuerpo vacío y más de 60s", y desde la persistencia incremental esa adivinanza ya
    // fallaba (un turno cortado a media respuesta tiene texto, no vacío).
    // ⚠️ Se EXCLUYE lo que este proceso tiene vivo ahora mismo. `sweepOrphans` corre la
    // primera vez que ESTE proceso toca ESE tenant —que puede ser horas después del arranque,
    // o durante un despliegue solapado— así que "todo lo running es huérfano" era falso: le
    // clavaba el aviso de interrupción a un documento que se estaba escribiendo en ese
    // instante.
    const vivosAhora = [...live.values()].map((t) => t.messageId);
    const excluir = vivosAhora.length ? ` AND message_id NOT IN (${vivosAhora.join(",")})` : "";
    await dbq(`UPDATE gt_turns SET state = 'interrupted', ended_at = ? WHERE state = 'running'${excluir}`, [
      Date.now(),
    ]).catch(() => {});
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
         WHERE streaming = 1 AND created_at < unixepoch() - 60${excluir ? excluir.replace("message_id", "id") : ""}`,
      ["\n\n⏹ _Interrumpido: el servidor se reinició mientras el agente escribía._"],
    ).catch(() => {});
    // ⚠️ 60s NO basta: un motor lento tarda más que eso en emitir el primer token (el propio
    // cliente tiene frases para turnos de más de 120s). Con el margen corto, un turno
    // legítimo que coincidiera con el primer request del tenant en un proceso nuevo se
    // llevaba un "Detenido" encima. 10 minutos deja fuera cualquier turno real.
    const rows = await dbq(
      `UPDATE gc_messages SET body = ?
         WHERE agent_handle IS NOT NULL
           AND (body IS NULL OR trim(body) = '')
           AND created_at < unixepoch() - 600${excluir ? excluir.replace("message_id", "id") : ""}
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
