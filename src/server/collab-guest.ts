import { createServerFn } from "@tanstack/react-start";
import type { DocRole } from "../db.server";
import type { CollabUser } from "./collab";

// Entrada a la sala para quien llega por LIGA, sin cuenta de GTeams.
//
// El socio del `docCollabConnFn` de los miembros, con dos diferencias que importan:
//
//   1. El rol NO se deduce de la membresía —no hay— sino del `share_role` del enlace.
//      Un link de sólo lectura no abre sala editable ni aunque el invitado insista: el
//      ticket viaja firmado y el sidecar corta las escrituras del lado del servidor.
//   2. La identidad la pone el invitado (su nombre), pero el `sub` lo acuña el SERVIDOR
//      y viaja en cookie: así el mismo visitante conserva su color entre recargas y no
//      puede hacerse pasar por el `sub` de un miembro.

const COOKIE = "gc_guest";

export type GuestConn = {
  wsUrl: string;
  room: string;
  token: string;
  title: string;
  initialHtml: string;
  user: CollabUser;
  role: DocRole;
};

// Paleta aparte de la de los miembros: de un vistazo se distingue quién es de casa.
const GUEST_COLORS = ["#0d9488", "#c2410c", "#4f46e5", "#a21caf", "#0369a1"];

function colorFor(sub: string): string {
  let h = 0;
  for (let i = 0; i < sub.length; i++) h = (h * 31 + sub.charCodeAt(i)) >>> 0;
  return GUEST_COLORS[h % GUEST_COLORS.length];
}

/** `sub` estable del visitante: lo lee de la cookie o acuña uno y lo siembra. */
async function guestSub(): Promise<string> {
  const { getCookie, setCookie } = await import("@tanstack/react-start/server");
  const previo = getCookie(COOKIE);
  if (previo) return `guest:${previo}`;
  const nuevo = crypto.randomUUID();
  setCookie(COOKIE, nuevo, {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 30,
  });
  return `guest:${nuevo}`;
}

export const guestCollabConnFn = createServerFn({ method: "POST" })
  .validator((d: { slug: string; name?: string }) => d)
  .handler(async ({ data }): Promise<{ ok: true; conn: GuestConn } | { ok: false; error: string }> => {
    await (await import("./schema.server")).ensureSchema().catch(() => {});

    const db = await import("../db.server");
    const root = await db.shareRootBySlug(data.slug);
    // Mismo silencio que el resto del camino público: "no existe" y "no puedes" se
    // responden igual, o el error confirma que el documento existe.
    if (!root || root.visibility !== "link") return { ok: false, error: "no disponible" };

    // Sólo comentar o editar abren sala. Un enlace de lectura se queda en su página.
    if (root.role === "view") return { ok: false, error: "este enlace es de sólo lectura" };

    const wsUrl = process.env.COLLAB_SIDECAR_WS_URL?.replace(/\/$/, "");
    if (!wsUrl) return { ok: false, error: "co-edición no configurada" };

    const sub = await guestSub();
    const nombre = (data.name ?? "").trim().slice(0, 40) || "Invitada";

    let token: string;
    try {
      const { mintCollabTicket } = await import("./collab-ticket.server");
      token = mintCollabTicket({
        doc: root.url,
        sub,
        name: nombre,
        avatar: "",
        color: colorFor(sub),
        role: root.role,
      });
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }

    const { seedHtmlFor } = await import("./collab");
    const doc = await db.getDoc(root.url);
    const initialHtml = await seedHtmlFor(doc?.md ?? null);

    return {
      ok: true,
      conn: {
        wsUrl,
        room: root.url,
        token,
        title: root.title ?? "Documento",
        initialHtml,
        user: { sub, name: nombre, avatar: "", color: colorFor(sub) },
        role: root.role,
      },
    };
  });
