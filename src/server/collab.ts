import { createServerFn } from "@tanstack/react-start";
import type { DocRole } from "../db.server";

// Puente de co-edición del artefacto nativo de GTeams. Resuelve TODO en casa:
//
//   permiso  → resolveDocRole (el mismo criterio que el panel y la descarga)
//   ticket   → mintCollabTicket (firmado; el sidecar lo verifica sin llamar a nadie)
//   semilla  → los bloques del sobre local (`gc_artifacts.md`)
//   estado   → el sidecar contra /api/collab/:docId/state
//
// Antes esto colgaba de EasyBits (mint del share token, sections del Landing, snapshot
// desde el browser). GTeams corre en su propia micro-nube: de EasyBits sólo se consumen
// tools públicas, así que el camino de co-edición se cortó el 2026-07-31.
//
// El WS (browser → sidecar) va directo; aquí sólo se prepara la conexión.

// Identidad REAL del participante en la sala (nombre/avatar de la sesión + color
// ESTABLE derivado del sub). Antes el editor inventaba `{name:"Editor", color:random}`
// en el cliente: todos los cursores se llamaban igual y cambiaban de color en cada
// montaje, así que la presencia no significaba nada. El color se deriva en el servidor
// para que el MISMO usuario se vea igual en todas las pestañas y sesiones.
export type CollabUser = {
  sub: string;
  name: string;
  avatar: string;
  color: string;
};

// Paleta de cursores (contraste suficiente sobre la hoja blanca del editor).
const CURSOR_COLORS = ["#e11d48", "#7c3aed", "#0891b2", "#16a34a", "#ea580c", "#db2777"];

function colorFor(sub: string): string {
  let h = 0;
  for (let i = 0; i < sub.length; i++) h = (h * 31 + sub.charCodeAt(i)) >>> 0;
  return CURSOR_COLORS[h % CURSOR_COLORS.length];
}

// Sesión → sólo miembros del team pueden abrir el editor.
async function requireUser() {
  const { useSession } = await import("@tanstack/react-start/server");
  const { sessionConfig } = await import("./session.server");
  const s = await useSession<{ user?: import("../users.server").SessionUser }>(sessionConfig());
  if (!s.data.user) throw new Error("no autorizado");
  return s.data.user;
}

export type CollabConn = {
  wsUrl: string;
  room: string;
  /** Ticket firmado (identidad + rol + documento). No es un share token de EasyBits. */
  token: string;
  title: string;
  initialHtml: string;
  /** Quién es el que se conecta — alimenta el caret y el rail de avatares. */
  user: CollabUser;
  /** Qué puede hacer. `view` se aplica ADEMÁS en el servidor: el cliente no manda. */
  role: DocRole;
};

// Resuelve {wsUrl, room, token, initialHtml, role} para montar el editor nativo.
export const docCollabConnFn = createServerFn({ method: "POST" })
  .validator((d: { documentId: string }) => d)
  .handler(async ({ data }): Promise<{ ok: true; conn: CollabConn } | { ok: false; error: string }> => {
    const me = await requireUser();
    const documentId = data.documentId;

    // El esquema de ESTE namespace, por si el tenant todavía no lo tiene: `share_role` es
    // columna nueva y `shareRootFor` la pide. Sin esto, abrir un documento antes de
    // cualquier actividad de chat en un team recién migrado reventaba la consulta.
    // Idempotente y barato — mismo patrón que chat.ts/dm.ts.
    await (await import("./schema.server")).ensureSchema().catch(() => {});

    // 1) Permiso. `null` = ni verlo; se responde lo mismo que si no existiera.
    const { resolveDocRole } = await import("./doc-access.server");
    const role = await resolveDocRole(documentId, { sub: me.sub, isOwner: me.isOwner });
    if (!role) return { ok: false, error: "sin acceso a este documento" };

    // 2) Sidecar co-locado en este team VM (`COLLAB_SIDECAR_WS_URL` = wss://sb-<uuid>-9400…).
    // Sin él no hay co-edición: ya no existe el fallback al box de EasyBits.
    const wsUrl = process.env.COLLAB_SIDECAR_WS_URL?.replace(/\/$/, "");
    if (!wsUrl) return { ok: false, error: "co-edición no configurada (COLLAB_SIDECAR_WS_URL)" };

    // 3) Ticket firmado: el sidecar verifica identidad y rol sin preguntarle a nadie.
    let token: string;
    try {
      const { mintCollabTicket } = await import("./collab-ticket.server");
      const { currentNamespace } = await import("./tenant.server");
      token = mintCollabTicket({
        doc: documentId,
        // El tenant se captura AQUÍ, donde el request todavía lo sabe: el sidecar llama
        // de vuelta por loopback y allá ya no hay host que mirar.
        ns: await currentNamespace(),
        sub: me.sub,
        name: me.name || me.email || "Alguien",
        avatar: me.avatar || "",
        color: colorFor(me.sub),
        role,
      });
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }

    // 4) Semilla: los bloques del documento vivo, renderizados a HTML. Sólo se usan si
    // el Y.Doc está vacío (documento que nunca se co-editó).
    const db = await import("../db.server");
    const doc = await db.getDoc(documentId);
    const { title, initialHtml } = await seedFrom(doc?.md ?? null);

    return {
      ok: true,
      conn: {
        wsUrl,
        room: documentId,
        token,
        title: title ?? "Documento",
        initialHtml,
        user: {
          sub: me.sub,
          name: me.name || me.email || "Alguien",
          avatar: me.avatar || "",
          color: colorFor(me.sub),
        },
        role,
      },
    };
  });

/**
 * Sobre local → HTML de arranque. Se hace en el SERVIDOR (ServerBlockNoteEditor maneja
 * su propio DOM) para no volver a pasar por markdown, que es lossy en los dos sentidos.
 * Un fallo aquí no debe tumbar la conexión: peor caso, el editor abre vacío y el Y.Doc
 * manda.
 */
export async function seedHtmlFor(md: string | null): Promise<string> {
  return (await seedFrom(md)).initialHtml;
}

async function seedFrom(md: string | null): Promise<{ title: string | null; initialHtml: string }> {
  if (!md) return { title: null, initialHtml: "<p></p>" };
  try {
    const { parseDocEnvelope } = await import("../lib/doc-blocks");
    const env = parseDocEnvelope(md);
    const blocks = env?.blocks ?? [];
    if (!blocks.length) return { title: null, initialHtml: "<p></p>" };

    const { ServerBlockNoteEditor } = await import("@blocknote/server-util");
    const { BlockNoteSchema } = await import("@blocknote/core");
    const { withMultiColumn } = await import("@blocknote/xl-multi-column");
    const server = ServerBlockNoteEditor.create({
      schema: withMultiColumn(BlockNoteSchema.create()),
    } as never);
    const html = await server.blocksToFullHTML(blocks as never);
    return { title: null, initialHtml: html || "<p></p>" };
  } catch (e) {
    console.error("[collab] seed falló:", (e as Error).message);
    return { title: null, initialHtml: "<p></p>" };
  }
}

