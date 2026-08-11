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
