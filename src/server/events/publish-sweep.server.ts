// ── Barrido de publicaciones a medias ───────────────────────────────────────
//
// `cerrarPublicaciones()` sólo corría al ABRIR el room, y ese era el único momento en todo
// el sistema en que alguien preguntaba si la caja ya terminó. Basta con que quien moderó
// cierre la pestaña al acabar el evento —que es exactamente lo que pasa— para que la
// grabación se quede en `pending` para siempre: la caja termina el HLS, sube las calidades,
// whisper deja el transcript… y nadie lo recoge. Peor, el disco de la caja no se libera
// hasta que se publica, así que el janitor acaba reciclándola con el `transcript.json`
// dentro y esa transcripción ya no se puede rehacer.
//
// Mismo molde que `reminders.server.ts` y `turns.server.ts`: un set de tenants, UN
// intervalo, `withNamespace` por vuelta. La verdad son las filas; el timer es desechable —
// un reinicio sólo puede publicar tarde, nunca perder.
//
// El tick es barato cuando no hay nada: una consulta por tenant que casi siempre devuelve
// cero filas. Sólo cuando hay algo pendiente se le pregunta a la caja.
import { dbq } from "../../dbq.server";

const tenants = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;

// Un minuto. Transcodificar las calidades chicas de una hora de vídeo tarda minutos, así
// que preguntar más seguido sólo despierta la caja para nada.
const SWEEP_MS = 60_000;

/** Llamado desde `ensureSchema`: este tenant existe y su tabla está lista. */
export function armPublishSweep(ns: string): void {
  tenants.add(ns);
  if (timer) return;
  timer = setInterval(() => {
    void (async () => {
      const { withNamespace } = await import("../tenant.server");
      for (const t of Array.from(tenants)) {
        // Un tenant con la base intermitente no puede dejar sin barrer a los demás.
        await withNamespace(t, () => sweepTenant()).catch(() => {});
      }
    })();
  }, SWEEP_MS);
  timer.unref?.();
}

/**
 * Cierra las publicaciones pendientes de TODOS los canales de este tenant.
 *
 * Se agrupa por canal porque `cerrarPublicaciones` trabaja por canal —necesita su
 * `call_course_id` para armar las URLs del bucket—, y porque así una grabación rota no
 * arrastra a las de otro room.
 */
export async function sweepTenant(): Promise<number> {
  // La misma ventana de 7 días que usa `cerrarPublicaciones`: pasada esa raya la caja ya
  // se recicló y seguir preguntando es gastar por gastar.
  const channels = await dbq(
    `SELECT DISTINCT channel_id FROM gt_event_recordings
      WHERE video_id IS NOT NULL
        AND COALESCE(publish_state, 'none') IN ('pending', 'partial')
        AND ended_at > unixepoch() - 604800`
  ).catch(() => []);
  if (!channels.length) return 0;

  const { cerrarPublicaciones } = await import("./recording.server");
  let closed = 0;
  for (const row of channels) {
    const channelId = Number(row.channel_id);
    if (!Number.isFinite(channelId)) continue;
    // Nunca lanza, por contrato: un fallo de publicación no puede tumbar el barrido.
    closed += await cerrarPublicaciones(channelId).catch(() => 0);
  }
  return closed;
}
