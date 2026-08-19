// ── Permisos ACP en vuelo ─────────────────────────────────────────────────────
//
// `session/request_permission` es lo que ACP trae y A2A no: el agente se DETIENE a pedir
// autorización antes de actuar. Y un hilo de chat resulta mejor superficie de aprobación que
// un modal en un IDE — es asíncrono, lo ve el equipo, y queda como bitácora.
//
// POR QUÉ HACE FALTA ESTADO EN MEMORIA. En A2A el turno termina: `INPUT_REQUIRED` aparca la
// tarea y contestar es un turno nuevo con el mismo `taskId`. En ACP el turno SIGUE VIVO —hay
// un WebSocket abierto y una petición JSON-RPC sin contestar— y el clic del usuario llega en
// OTRA petición HTTP. Este módulo es el punto de encuentro entre las dos: una promesa que el
// clic resuelve.
//
// Esperar minutos a un humano es seguro aquí porque la caja no se congela mientras tanto: el
// `/busy` del relé mide SOCKETS y no turnos, y su heartbeat de 30 s mantiene viva la conexión
// callada. Sin esas dos decisiones previas esto no aguantaría.
//
// Es efímero a propósito, como `live` en turns.server.ts: un permiso pendiente NO sobrevive a
// un deploy. Al reiniciar se pierde y el turno queda rechazado — que es el default correcto.

export type PermisoPendiente = {
  askId: string;
  /** Lo que el agente quiere hacer. */
  title: string;
  options: { id: string; label: string; kind?: string }[];
};

type Entrada = {
  resolve: (optionId: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
  at: number;
};

/**
 * ⚠️ CLAVE COMPUESTA `ns|askId`, por la misma razón que `live` en turns.server.ts lleva el
 * `ns` dentro: un proceso sirve N workspaces. Aquí el `askId` es aleatorio, así que no hay
 * colisión accidental — lo que se está cerrando es la DELIBERADA: sin el `ns` en la clave,
 * alguien de otro espacio que se hiciera de un `askId` podría autorizarle a un agente ajeno
 * que borre un archivo. Un permiso resuelto por el tenant equivocado es peor que un id
 * pisado.
 */
const pendientes = new Map<string, Entrada>();
const claveDe = (ns: string, askId: string) => `${ns}|${askId}`;

/** Cinco minutos. Suficiente para que alguien vuelva al hilo, no tanto como para colgar la caja. */
export const PERMISO_TTL_MS = 5 * 60_000;

/**
 * Registra el permiso y espera la respuesta.
 *
 * Al vencer resuelve `null` — el silencio se lee como NO. Un permiso que se concede porque
 * nadie estaba mirando no es un permiso.
 */
export function esperarPermiso(
  ns: string,
  p: PermisoPendiente,
  timeoutMs: number = PERMISO_TTL_MS,
): Promise<string | null> {
  const k = claveDe(ns, p.askId);
  return new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => {
      pendientes.delete(k);
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
    pendientes.set(k, { resolve, timer, at: Date.now() });
  });
}

/**
 * Contesta un permiso. `optionId` null rechaza.
 *
 * Devuelve `false` si ya no está esperando —contestada, vencida, o el proceso se reinició— en
 * vez de fallar en silencio: el botón tiene que poder decir la verdad.
 */
export function resolverPermiso(ns: string, askId: string, optionId: string | null): boolean {
  const k = claveDe(ns, askId);
  const e = pendientes.get(k);
  if (!e) return false;
  pendientes.delete(k);
  clearTimeout(e.timer);
  e.resolve(optionId);
  return true;
}

/** ¿Sigue esperando? Para pintar la tarjeta sin botones muertos. */
export function permisoVivo(ns: string, askId: string): boolean {
  return pendientes.has(claveDe(ns, askId));
}

/** Cuántos hay esperando. Sólo para tests y diagnóstico. */
export function permisosVivos(): number {
  return pendientes.size;
}

/**
 * Barrido de huérfanos, como `sweepOrphans`. El `setTimeout` de cada entrada ya se limpia
 * sola; esto es el cinturón por si alguna se queda sin timer (un `clearTimeout` de más, un
 * error entre el `set` y el `setTimeout`).
 */
export function barrerPermisos(maxEdadMs: number = PERMISO_TTL_MS * 2): number {
  const corte = Date.now() - maxEdadMs;
  let n = 0;
  for (const [k, e] of [...pendientes]) {
    if (e.at > corte) continue;
    pendientes.delete(k);
    clearTimeout(e.timer);
    e.resolve(null);
    n++;
  }
  return n;
}
