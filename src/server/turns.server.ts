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
  // ── Con qué RETOMAR el turno si muere. Ver las columnas en schema.server.ts ──────────
  /** El texto ÍNTEGRO que escribió la persona. `tarea` está recortada a 60 y no sirve. */
  body?: string;
  /** Room al que pertenece. Junto con `dmId` es lo que dice a dónde devolver el reintento. */
  slug?: string;
  /** Adjuntos del mensaje original, serializados. */
  attachments?: unknown[];
  /** La cáscara del agente, para reusarla en el reintento en vez de crear otra burbuja. */
  shellId?: number | null;
  /**
   * Los mensajes de la persona que dispararon este turno, para cerrarles el acuse 👀 →
   * ✅/⏹/⚠️ (`agent-ack.server.ts`).
   *
   * ⚠️ Es una LISTA, no un id: con STEER, un segundo mensaje del mismo invocador se mete en
   * el turno EN CURSO y `postMessage` ya le puso su propio 👀. Guardando sólo el primero,
   * ese 👀 se queda clavado para siempre — nadie más vuelve por él.
   */
  invokerMessageIds?: number[];

  // ── AUTORIDAD del turno. Ver `inflightAuthority`. ────────────────────────────────────
  //
  // ⚠️ Esto NO es para pintar: es contra lo que un servidor MCP resuelve a nombre de quién
  // ejerce las tools un agente de fuera. Sin `publicChannel` aquí no se puede reproducir la
  // regla más dura del sistema —en canal público NUNCA hay tools (acp-tools.server.ts)— y
  // sin `scope` el agente ejercería más de lo que su dueño le concedió.
  //
  // `channelId`/`dmId`/`parentId` ya estaban arriba para la barra; el `dest` completo lleva
  // además `topic`, `handle`, `name` y `memoryScope`, que es lo que las tools nativas usan
  // para saber DÓNDE actuar.
  /** El destino tal como se firma en el tool-token. */
  dest?: unknown;
  /** Qué familias de tools puede ejercer. CSV/Set según `parseScope`. */
  scope?: unknown;
  /** El handle del agente. `agent` es el NOMBRE para pintar; el acuse necesita el handle. */
  handle?: string | null;
  /** Canal público: el texto del turno lo escribe un extraño. Nunca hay tools. */
  publicChannel?: boolean;
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
/**
 * A nombre de quién y dónde puede ejercer tools QUIEN ESTÉ CORRIENDO en esta conversación.
 *
 * Existe para el servidor MCP: un agente ACP de fuera recibe una URL cuyo ticket sólo dice
 * QUÉ conversación es. La autoridad —el `sub` del invocador, el destino, el alcance— sale de
 * aquí, del turno vivo, no del ticket. Sin turno en curso no hay autoridad y la llamada se
 * rechaza; es lo que evita que una URL filtrada valga para algo.
 *
 * ⚠️ Devuelve `null` si hay MÁS DE UNO corriendo. Normalmente es imposible —el turno entero
 * va dentro de `withGroupLock` y uno encolado ni siquiera recibió su prompt— pero el lock se
 * suelta a los `GROUP_LOCK_TIMEOUT_MS` y ahí sí pueden solaparse dos. Atribuir la llamada al
 * invocador equivocado sería ejercer los conectores de una persona a petición de otra: ante
 * la duda, no.
 */
/**
 * Quién está DENTRO del lock, por grupo. Un `Set` y no un valor: si el lock se suelta a los
 * `GROUP_LOCK_TIMEOUT_MS` puede haber dos, y eso hay que poder verlo para rechazar en vez de
 * elegir a uno.
 */
const ejecutando = new Map<string, Set<{ ns: string; getId: () => number | null }>>();

export function inflightAuthority(
  groupId: string,
): { ns: string; messageId: number; invokerSub: string | null; dest: unknown; scope: unknown; publicChannel: boolean } | null {
  const dentro = ejecutando.get(groupId);
  if (!dentro || dentro.size !== 1) return null;
  const [quien] = dentro;
  const id = quien.getId();
  if (id == null) return null;
  const t = live.get(claveDe(quien.ns, id));
  if (!t || t.stopped) return null;
  return {
    ns: t.ns,
    messageId: t.messageId,
    invokerSub: t.invokerSub ?? null,
    dest: t.dest,
    scope: t.scope,
    publicChannel: !!t.publicChannel,
  };
}

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

/**
 * Cada cuánto late un turno vivo, y cuánto silencio lo da por muerto.
 *
 * El latido es lo que distingue "trabajando" de "el proceso que lo atendía ya no existe", y
 * hasta ahora esa distinción no se podía hacer: el barrido la ADIVINABA por la edad del
 * mensaje. 15 s de latido y 90 s de gracia dejan margen de sobra para un event loop ocupado
 * —seis latidos perdidos seguidos— sin que un huérfano se quede media hora en "pensando".
 */
const HEARTBEAT_MS = 15_000;
const LEASE_S = 90;

/**
 * UN intervalo por proceso, no uno por turno.
 *
 * Con N turnos simultáneos, N timers escribiendo N filas cada 15 s es ruido de escrituras en
 * una base que es de UN tenant; una sola sentencia los cubre a todos. `.unref()` para que el
 * proceso pueda salir limpio en el deploy (sin él, systemd cuelga hasta el SIGKILL).
 */
let latido: ReturnType<typeof setInterval> | null = null;
function asegurarLatido(): void {
  if (latido || live.size === 0) return;
  latido = setInterval(() => {
    void latir();
  }, HEARTBEAT_MS);
  latido.unref?.();
}

// ── Barrido periódico de turnos sin latido ──────────────────────────────────
//
// El barrido de ARRANQUE (`sweepOrphans`, desde `ensureSchema`) sólo corre la primera vez que
// este proceso toca un tenant. Con despliegues solapados eso deja un hueco real: el proceso
// viejo muere con turnos en vuelo y el nuevo ya tocó ese tenant, así que nadie vuelve a mirar
// y la burbuja se queda en "pensando" hasta el siguiente reinicio — el modo de falla que
// Slack nombra como *el pensando eterno*.
//
// Mismo molde que `reminders.server.ts`: un set de tenants, UN intervalo, `withNamespace` por
// vuelta. La verdad son las filas; el timer es desechable.
const tenantsConTurnos = new Set<string>();
let barrido: ReturnType<typeof setInterval> | null = null;
const SWEEP_MS = 60_000;

/** Llamado desde `ensureSchema`: este tenant existe y su tabla está lista. */
export function armTurnSweep(ns: string): void {
  tenantsConTurnos.add(ns);
  if (barrido) return;
  barrido = setInterval(() => {
    void (async () => {
      const { withNamespace } = await import("./tenant.server");
      for (const t of Array.from(tenantsConTurnos)) {
        // Un tenant con la base intermitente no puede dejar sin barrer a los demás.
        await withNamespace(t, () => sweepOrphans(t)).catch(() => {});
      }
    })();
  }, SWEEP_MS);
  barrido.unref?.();
}

async function latir(): Promise<void> {
  if (live.size === 0) {
    if (latido) clearInterval(latido);
    latido = null;
    return;
  }
  // ⚠️ POR TENANT, y con `withNamespace`.
  //
  // Este tick corre FUERA de un request, así que `dbq` no tiene de dónde sacar el namespace
  // y cae al del env: sin esto, el latido de TODOS los workspaces se escribiría en la base de
  // uno solo — y los demás se darían por muertos mientras trabajan. Es la misma trampa que
  // ya está documentada en `reminders.server.ts` y en `sentry-enrich.server.ts`.
  const porNs = new Map<string, number[]>();
  for (const t of live.values()) {
    const ids = porNs.get(t.ns) ?? [];
    ids.push(t.messageId);
    porNs.set(t.ns, ids);
  }
  const { withNamespace } = await import("./tenant.server");
  for (const [ns, ids] of porNs) {
    // `unixepoch()` — el reloj de la BASE. Escribir el latido con el reloj de Node y
    // compararlo con el de SQLite es la forma clásica de cerrar turnos a destiempo.
    await withNamespace(ns, () =>
      persistir(`UPDATE gt_turns SET heartbeat_at = unixepoch() WHERE message_id IN (${ids.join(",")})`, []),
    ).catch(() => {});
  }
}

export function registerTurn(t: Omit<LiveTurn, "startedAt"> & { startedAt?: number }): LiveTurn {
  const entry: LiveTurn = { ...t, startedAt: t.startedAt ?? Date.now() };
  live.set(claveDe(entry.ns, entry.messageId), entry);
  // ⚠️ El primer latido va DENTRO del INSERT, no en una escritura aparte ni en el primer tick
  // del intervalo: un turno que nace con `heartbeat_at` nulo lo daría por huérfano cualquier
  // barrido que corriera en ese hueco — y el hueco dura hasta 15 s.
  void persistir(
    `INSERT INTO gt_turns (message_id, group_id, invoker_sub, channel_id, parent_id, agent, avatar, tarea, state, started_at, heartbeat_at, body, dm_id, slug, attachments, shell_id, tools_json, invoker_message_ids, agent_handle)
     VALUES (?,?,?,?,?,?,?,?,'running',?,unixepoch(),?,?,?,?,?,NULL,?,?)
     ON CONFLICT(message_id) DO UPDATE SET state='running', started_at=excluded.started_at, ended_at=NULL, outcome=NULL, error=NULL, heartbeat_at=unixepoch(),
       body=excluded.body, dm_id=excluded.dm_id, slug=excluded.slug, attachments=excluded.attachments, shell_id=excluded.shell_id, tools_json=NULL,
       invoker_message_ids=excluded.invoker_message_ids, agent_handle=excluded.agent_handle`,
    [entry.messageId, entry.groupId, entry.invokerSub ?? null, entry.channelId ?? null,
     entry.parentId ?? null, entry.agent ?? null, entry.avatar ?? null, entry.tarea ?? null, entry.startedAt,
     entry.body ?? null, entry.dmId ?? null, entry.slug ?? null,
     entry.attachments?.length ? JSON.stringify(entry.attachments) : null, entry.shellId ?? null,
     entry.invokerMessageIds?.length ? JSON.stringify(entry.invokerMessageIds) : null,
     entry.handle ?? null],
  );
  asegurarLatido();
  announceGroup(entry.groupId);
  return entry;
}

/**
 * Cuelga otro mensaje invocador del turno VIVO de este grupo, para que su cierre le quite
 * también el 👀. Devuelve el turno afectado, o null si no había ninguno.
 *
 * ⚠️ Existe por el STEER: si escribes otra vez con tu turno corriendo, el mensaje se mete en
 * el turno EN CURSO y `postMessage` ya le puso su acuse. Sin esto, ese 👀 no lo quita nadie
 * — el turno cierra conociendo sólo el primer mensaje.
 */
export function addInvokerMessage(
  groupId: string,
  invokerSub: string | null | undefined,
  messageId: number
): LiveTurn | null {
  for (const t of live.values()) {
    if (t.groupId !== groupId || t.stopped) continue;
    if (invokerSub && t.invokerSub !== invokerSub) continue;
    const ids = (t.invokerMessageIds ??= []);
    if (ids.includes(messageId)) return t;
    ids.push(messageId);
    void persistir("UPDATE gt_turns SET invoker_message_ids = ? WHERE message_id = ?", [
      JSON.stringify(ids),
      t.messageId,
    ]);
    return t;
  }
  return null;
}

/** Lo que el turno acabó produciendo, para la fila de "terminó". Se calcula UNA vez. */
export function setTurnOutcome(_ns: string, messageId: number, outcome: string): void {
  void persistir("UPDATE gt_turns SET outcome = ? WHERE message_id = ?", [outcome, messageId]);
}

/**
 * Las tools que YA corrieron en este turno.
 *
 * Es lo que hace segura la reanudación: el prompt de continuación enumera HECHOS en vez de
 * pedirle al modelo que recuerde, y permite avisar si corrió algo irreversible antes de
 * dejar reintentar. Se reescribe entera (la lista es corta y así no hay que leer-modificar).
 */
export function setTurnTools(_ns: string, messageId: number, tools: string[]): void {
  void persistir("UPDATE gt_turns SET tools_json = ? WHERE message_id = ?", [JSON.stringify(tools), messageId]);
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
// `ns` sólo lo usa el cierre del acuse (necesita publicar al bus, que es por tenant). El
// resto del barrido ya corre dentro de `withNamespace`.
export async function sweepOrphans(ns?: string): Promise<number> {
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
    // ⚠️ EL LATIDO manda, no la lista de exclusión.
    //
    // La exclusión de "lo que este proceso tiene vivo" seguía siendo una adivinanza con una
    // premisa falsa: cubre a ESTE proceso, pero durante un despliegue solapado hay OTRO
    // atendiendo turnos legítimos que este barrido no ve, y se los cerraba. Un turno vivo es
    // el que LATE — venga del proceso que venga. Se conserva la exclusión local como red por
    // si el latido no llegó a escribirse todavía (turno recién nacido, base lenta).
    const vivosAhora = [...live.values()].map((t) => t.messageId);
    const excluir = vivosAhora.length ? ` AND message_id NOT IN (${vivosAhora.join(",")})` : "";
    const late = ` AND (heartbeat_at IS NULL OR heartbeat_at < unixepoch() - ${LEASE_S})`;
    const muertos = await dbq(
      `UPDATE gt_turns SET state = 'expired', ended_at = ?, error = ?
         WHERE state = 'running'${late}${excluir}
       RETURNING message_id, invoker_message_ids, agent_handle`,
      [Date.now(), "el proceso que lo atendía dejó de latir"],
    ).catch(() => [] as { message_id?: unknown; invoker_message_ids?: unknown; agent_handle?: unknown }[]);
    // Cierra el acuse 👀 de los turnos que acaban de darse por muertos. Es el caso COMÚN,
    // no el raro: cada deploy mata los turnos en vuelo. Sin esto el 👀 queda clavado y ya
    // nadie vuelve por él — el turno ni siquiera existe en memoria.
    // ⚠️ El estado del proceso ya no sirve aquí: los ids salen de la columna, que es para
    // lo que se persiste.
    for (const fila of muertos) {
      const handle = typeof fila.agent_handle === "string" ? fila.agent_handle : "";
      if (!handle || typeof fila.invoker_message_ids !== "string") continue;
      const ids = JSON.parse(fila.invoker_message_ids) as unknown;
      if (!Array.isArray(ids) || !ids.length) continue;
      if (!ns) continue;
      const { ackEnd } = await import("./agent-ack.server");
      // ⏹, no ⚠️: es lo mismo que dice la cáscara aquí abajo ("el servidor se reinició").
      await ackEnd(ns, ids.map(Number).filter(Number.isFinite), handle, "stopped").catch(() => {});
    }
    // Sólo se cierran las cáscaras de los turnos que ACABAN de darse por muertos. Antes se
    // barría por edad del mensaje (60 s / 600 s), que es de dónde salían los dos falsos
    // positivos documentados aquí abajo: un motor lento y un turno que empezó justo antes.
    const huerfanos = muertos.map((f) => Number(f.message_id)).filter(Number.isFinite);
    if (huerfanos.length) {
      const enIds = `(${huerfanos.join(",")})`;
      // Al huérfano CON texto no se le borra lo escrito: se le añade el aviso. Lo que el
      // agente alcanzó a redactar suele ser la mitad de un documento.
      await dbq(
        `UPDATE gc_messages SET body = body || ?, streaming = 0 WHERE id IN ${enIds} AND streaming = 1`,
        ["\n\n⏹ _Interrumpido: el servidor se reinició mientras el agente escribía._"],
      ).catch(() => {});
      await dbq(
        `UPDATE gc_messages SET body = ?, streaming = 0
           WHERE id IN ${enIds} AND (body IS NULL OR trim(body) = '')`,
        ["⏹ Detenido (el servidor se reinició)."],
      ).catch(() => {});
      console.log(`[turns] barrido: ${huerfanos.length} turno(s) sin latido cerrado(s)`);
    }
    return huerfanos.length;
  } catch (e) {
    // Best-effort: esto es limpieza, no puede tumbar el arranque de un tenant.
    console.error("[turns] sweepOrphans falló", e);
    return 0;
  }
}

// ── Serialización del ARMADO de un turno ────────────────────────────────────
//
// El worker ya serializa los turnos de un mismo `groupId` (su lock por sesión), pero eso
// pasa TARDE: para entonces Teams ya construyó el contexto de los dos. Dos personas que
// mencionan al agente en el mismo room a la vez producen dos turnos que leen la base
// CONCURRENTEMENTE, antes de que ninguno haya escrito nada.
//
// ⚠️ Y eso PIERDE DATOS, no sólo calidad de contexto: `artifactDocHint` le inyecta a cada
// turno el artefacto vigente al momento de armarlo. El segundo turno se lleva la versión
// ANTERIOR, el agente la re-emite, y la edición del primero desaparece sin ninguna señal.
// El mismo patrón afecta al catch-up (el gap no excluye lo que el agente acaba de decir) y
// a la memoria del room.
//
// La cura es barata: encadenar el ARMADO (no el streaming) de los turnos del mismo grupo,
// para que el segundo lea la base DESPUÉS de las escrituras del primero. Son un puñado de
// queries indexadas, así que el p99 no se mueve.
//
// ⚠️ Es un lock EN PROCESO: asume un solo nodo de Teams, igual que `live`. Si algún día hay
// varias réplicas, esto tiene que mudarse a un advisory lock en la base — un lock local con
// dos procesos da una falsa sensación de seguridad, que es peor que no tenerlo.
const groupLocks = new Map<string, Promise<void>>();

/**
 * Tras este tiempo se sigue SIN lock. Un turno atorado no puede trabar un room entero.
 *
 * Configurable sólo para poder PROBAR lo que pasa cuando se suelta: ahí dos turnos del mismo
 * grupo corren de verdad a la vez, y es el único caso en que `inflightAuthority` no sabe a
 * nombre de quién actuaría un agente. Sin poder bajarlo, ese test tardaría diez segundos.
 */
const GROUP_LOCK_TIMEOUT_MS = Number(process.env.GROUP_LOCK_TIMEOUT_MS) || 10_000;

export async function withGroupLock<T>(
  groupId: string,
  fn: () => Promise<T>,
  /**
   * Quién está ejecutando, para poder resolver su autoridad mientras dure. El id se pide con
   * una función y no como número porque la cáscara del mensaje SE CREA DENTRO del turno: al
   * tomar el lock todavía no existe. Ver `inflightAuthority`.
   */
  turno?: { ns: string; getId: () => number | null },
): Promise<T> {
  const previo = groupLocks.get(groupId);
  let liberar!: () => void;
  const mio = new Promise<void>((r) => (liberar = r));
  groupLocks.set(groupId, mio);
  try {
    if (previo) {
      // `Promise.race` con un timer: esperar al anterior, pero nunca para siempre.
      let t: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        previo,
        new Promise<void>((r) => {
          t = setTimeout(() => {
            console.warn(`[turns] lock de ${groupId} excedió ${GROUP_LOCK_TIMEOUT_MS}ms; sigo sin él`);
            r();
          }, GROUP_LOCK_TIMEOUT_MS);
        }),
      ]);
      if (t) clearTimeout(t);
    }
    if (!turno) return await fn();
    let grupo = ejecutando.get(groupId);
    if (!grupo) ejecutando.set(groupId, (grupo = new Set()));
    grupo.add(turno);
    try {
      return await fn();
    } finally {
      grupo.delete(turno);
      if (!grupo.size) ejecutando.delete(groupId);
    }
  } finally {
    liberar();
    // Sólo se borra si nadie se encadenó detrás: si otro turno ya puso el suyo, borrarlo
    // dejaría al siguiente sin nada que esperar.
    if (groupLocks.get(groupId) === mio) groupLocks.delete(groupId);
  }
}

// ── Retomar un turno que murió ────────────────────────────────────────────────────────
//
// Medido en descti (2026-08-28): 4 turnos de 67 murieron sin entregar nada y se cobraron
// enteros — 705,399 facturables, el 17% del gasto del mes. Retomar es BARATO: cuando uno
// murió, el usuario escribió "@ghosty termina la ultima tarea" y el turno siguiente lo
// completó en 183 s.
//
// La seguridad de esto NO es que el modelo "no rehará lo ya hecho" —eso es comportamiento,
// no garantía— sino que el turno nuevo **resume la misma sesión del SDK** (mismo groupId):
// el transcript vive en S3 y el modelo LEE lo que hizo en vez de recordarlo. Repetir la
// petición sería estrictamente peor: se reejecuta desde cero *y* resume igual la sesión.

/**
 * Tools cuyo efecto NO se puede deshacer: si alguna corrió, el reintento se confirma a mano.
 *
 * ⚠️ Es una lista de SUCIAS, no de limpias, y el default es sucio. `Bash` es la tool
 * dominante y es arbitrariamente destructiva, así que cualquier cosa que no esté en
 * `LIMPIAS` se trata como efecto secundario.
 *
 * ⚠️ NO reutilizar `SOLO_LECTURA` de connectors/tools.server.ts: incluye `chat_message`,
 * que ENVÍA. Sirve para acotar permisos, no para decidir idempotencia.
 */
const LIMPIAS = new Set(["Read", "Grep", "Glob", "chat_history", "chat_search", "chat_message_read", "doc_read"]);

export type TurnoMuerto = {
  messageId: number;
  groupId: string;
  invokerSub: string | null;
  channelId: number | null;
  parentId: number | null;
  dmId: number | null;
  slug: string | null;
  shellId: number | null;
  agent: string | null;
  body: string;
  attachments: unknown[];
  tools: string[];
  /** Tools cuyo efecto no se puede deshacer. Vacío = el reintento no necesita confirmarse. */
  sucias: string[];
  /** No sabemos QUÉ corrió (el proceso murió antes de poder anotarlo). Falla cerrado. */
  toolsDesconocidas: boolean;
  error: string | null;
};

/**
 * Lee un turno que murió y decide si se puede retomar.
 *
 * Devuelve `null` si el turno no existe, si no murió (nadie retoma algo que entregó) o si
 * la fila es anterior a las columnas de reanudación — en ese último caso no hay con qué
 * re-disparar y ofrecerlo sería un botón que falla.
 */
export async function turnoMuerto(messageId: number): Promise<TurnoMuerto | null> {
  try {
    const { dbq } = await import("../dbq.server");
    const [f] = await dbq(
      `SELECT message_id, group_id, invoker_sub, channel_id, parent_id, dm_id, slug, shell_id,
              agent, body, attachments, tools_json, error, state, outcome
         FROM gt_turns WHERE message_id = ?`,
      [messageId],
    );
    if (!f) return null;
    // Murió = el barrido lo dio por huérfano, o el catch del turno lo marcó como fallo.
    const murio = f.state === "expired" || String(f.outcome ?? "").startsWith("error:");
    if (!murio) return null;
    const body = (f.body as string) ?? "";
    if (!body.trim()) return null; // fila vieja, sin con qué re-disparar
    // ⚠️ NULL no es "ninguna": es "no lo sabemos". Sólo se escribe cuando el turno muere de
    // forma ordenada; si el PROCESO murió (deploy, OOM) nadie llegó a anotarlo. Leerlo como
    // "no corrió nada" haría que el reintento se ofreciera sin aviso justo en el caso en que
    // más pudo haberse ejecutado algo irreversible.
    const toolsDesconocidas = f.tools_json == null;
    const tools: string[] = f.tools_json ? (JSON.parse(String(f.tools_json)) as string[]) : [];
    return {
      messageId: Number(f.message_id),
      groupId: String(f.group_id),
      invokerSub: (f.invoker_sub as string) ?? null,
      channelId: f.channel_id != null ? Number(f.channel_id) : null,
      parentId: f.parent_id != null ? Number(f.parent_id) : null,
      dmId: f.dm_id != null ? Number(f.dm_id) : null,
      slug: (f.slug as string) ?? null,
      shellId: f.shell_id != null ? Number(f.shell_id) : null,
      agent: (f.agent as string) ?? null,
      body,
      attachments: f.attachments ? (JSON.parse(String(f.attachments)) as unknown[]) : [],
      tools,
      sucias: [...new Set(tools.filter((t) => !LIMPIAS.has(t)))],
      toolsDesconocidas,
      error: (f.error as string) ?? (f.outcome as string) ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * El texto con el que se retoma. ENUMERA lo que ya se hizo en vez de pedir confianza.
 *
 * Va como mensaje del usuario y no como system prompt a propósito: el system prompt entra
 * por VALOR en el `configSig` del worker, así que un bloque que cambia cada turno reciclaría
 * la sesión persistente — y perder la sesión es perder justo lo que hace barato retomar.
 */
export function textoDeContinuacion(t: TurnoMuerto): string {
  const hechos = t.toolsDesconocidas
    ? "No hay registro de qué herramientas alcanzaste a ejecutar: REVISA tu propio historial antes de repetir nada."
    : t.tools.length
      ? `Ya alcanzaste a ejecutar: ${t.tools.join(", ")}. Eso está hecho — no lo repitas.`
      : "No alcanzaste a ejecutar ninguna herramienta.";
  return (
    `[Tu turno anterior se cortó por una falla de la plataforma, no por algo que hicieras mal. ` +
    `${hechos} Revisa tu propio historial para ver dónde te quedaste y CONTINÚA desde ahí ` +
    `hasta entregar. No vuelvas a empezar.]\n\n` +
    `La petición original era:\n${t.body}`
  );
}
