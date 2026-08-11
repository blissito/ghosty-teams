import { createServerFn } from "@tanstack/react-start";
import { sessionUser } from "./chat";

// Server fns del panel de WhatsApp. Sólo LEE y DESCONECTA: conectar es un redirect al
// wizard de Formmy (`/api/whatsapp/connect/start`), no una llamada desde el cliente.

export type WaChannelView = {
  integrationId: string;
  phone: string;
  roomSlug: string | null;
  roomName: string | null;
  agentHandle: string | null;
};

/** Los números conectados, con el room donde aterrizan. Owner-only: es config del workspace. */
export const listWaChannelsFn = createServerFn({ method: "GET" }).handler(async () => {
  const me = await sessionUser();
  if (!me?.isOwner) return { channels: [] as WaChannelView[], canManage: false };
  await (await import("./schema.server")).ensureSchema().catch(() => {});
  const { listWaChannels } = await import("./whatsapp/channels.server");
  const { dbq } = await import("../dbq.server");
  const rows = await listWaChannels();
  const out: WaChannelView[] = [];
  for (const c of rows) {
    // El room puede haberse archivado o borrado desde que se conectó: se enseña el número
    // igual, con el destino en blanco, para que se pueda reapuntar o desconectar. Ocultarlo
    // dejaría un número recibiendo mensajes sin nada en la interfaz que lo explique.
    const r = await dbq("SELECT slug, name FROM gc_channels WHERE id = ?", [c.roomId]).catch(
      () => [],
    );
    out.push({
      integrationId: c.integrationId,
      phone: c.phone,
      roomSlug: r[0]?.slug ?? null,
      roomName: r[0]?.name ?? null,
      agentHandle: c.agentHandle,
    });
  }
  return { channels: out, canManage: true };
});

export type WaConversation = {
  integrationId: string;
  phone: string;
  contactName: string | null;
  threadId: number;
  lastMessageAt: number | null;
  pausedUntil: number | null;
};

/**
 * La bandeja: conversaciones de WhatsApp, la más reciente primero.
 *
 * Con cientos de contactos, el room es un log — se puede leer pero no se puede TRABAJAR.
 * Esto es la vista de atención: buscar por nombre o teléfono y ver quién está tomada.
 *
 * La búsqueda va en SQL y no filtrando en el cliente: mandar cientos de filas al navegador
 * para que descarte 99% es el tipo de cosa que funciona en la demo y no en producción.
 */
export const listWaConversationsFn = createServerFn({ method: "GET" })
  .validator((d: { q?: string; onlyPaused?: boolean } | undefined) => d ?? {})
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return { conversations: [] as WaConversation[] };
    await (await import("./schema.server")).ensureSchema().catch(() => {});
    const { dbq, num } = await import("../dbq.server");
    const q = (data.q ?? "").trim();
    // El teléfono se busca por dígitos: la gente teclea "55 1234" o "+52 55…" y esperaría
    // encontrarlo igual.
    const digits = q.replace(/\D/g, "");
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q) {
      where.push(`(contact_name LIKE ? ${digits ? "OR phone LIKE ?" : ""})`);
      args.push(`%${q}%`);
      if (digits) args.push(`%${digits}%`);
    }
    if (data.onlyPaused) where.push(`paused_until IS NOT NULL AND paused_until > unixepoch()`);
    const rows = await dbq(
      `SELECT integration_id, phone, contact_name, thread_id, last_message_at, paused_until
         FROM gt_wa_threads
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY COALESCE(last_message_at, created_at) DESC
        LIMIT 200`,
      args,
    ).catch(() => []);
    return {
      conversations: rows.map((r) => ({
        integrationId: String(r.integration_id ?? ""),
        phone: String(r.phone ?? ""),
        contactName: r.contact_name ?? null,
        threadId: num(r.thread_id),
        lastMessageAt: r.last_message_at != null ? num(r.last_message_at) : null,
        pausedUntil: r.paused_until != null ? num(r.paused_until) : null,
      })) as WaConversation[],
    };
  });

/**
 * Toma o suelta una conversación (el agente se calla / vuelve).
 *
 * Cualquier miembro, no sólo el owner: quien está atendiendo es quien tiene que poder
 * callar al agente, y pedir permiso al dueño a media conversación con un cliente no es una
 * opción real.
 */
export const setWaPauseFn = createServerFn({ method: "POST" })
  .validator((d: { integrationId: string; phone: string; paused: boolean }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) throw new Error("no autenticado");
    const { setThreadPause } = await import("./whatsapp/channels.server");
    await setThreadPause(data.integrationId, data.phone, data.paused, me.sub);
    return { ok: true as const };
  });

/**
 * Cambia el agente que atiende un número, sin volver a parear.
 *
 * Cadena vacía = nadie atiende. Es un estado legítimo y a veces el que se quiere: el número
 * sigue recibiendo y el equipo contesta a mano desde el room.
 */
export const setWaAgentFn = createServerFn({ method: "POST" })
  .validator((d: { integrationId: string; handle: string }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me?.isOwner) throw new Error("solo el owner");
    const { setWaAgent } = await import("./whatsapp/channels.server");
    await setWaAgent(data.integrationId, data.handle || null);
    return { ok: true as const };
  });

/**
 * Deja de recibir de un número.
 *
 * ⚠️ Sólo borra NUESTRA mitad. La conexión con Meta vive en Formmy y sigue viva: el número
 * se queda registrado allá y el webhook seguirá llegando, sólo que caerá en el `orphaned`
 * del endpoint. Para dar de baja el número de verdad hay que desconectarlo en Formmy —
 * media operación falla en silencio en las dos direcciones, igual que con los asientos.
 */
export const disconnectWaFn = createServerFn({ method: "POST" })
  .validator((d: { integrationId: string }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me?.isOwner) throw new Error("solo el owner");
    const { deleteWaChannel } = await import("./whatsapp/channels.server");
    await deleteWaChannel(data.integrationId);
    return { ok: true as const };
  });
