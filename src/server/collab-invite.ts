import { createServerFn } from "@tanstack/react-start";
import type { GuestConn } from "./collab-guest";

// Canje de una invitación nominal: token del correo → conexión a la sala.
//
// Diferencia con la puerta del enlace abierto (`guestCollabConnFn`): aquí la identidad
// NO es lo que el visitante teclee. El token llegó a un correo concreto, así que el
// `sub` del ticket se ancla a ESE correo — dos personas distintas no pueden aparecer
// como la misma, y quien editó queda atribuible. El nombre se pide sólo para mostrarlo
// bonito junto al caret; el correo es lo que identifica.

const GUEST_COLORS = ["#0d9488", "#c2410c", "#4f46e5", "#a21caf", "#0369a1"];

function colorFor(sub: string): string {
  let h = 0;
  for (let i = 0; i < sub.length; i++) h = (h * 31 + sub.charCodeAt(i)) >>> 0;
  return GUEST_COLORS[h % GUEST_COLORS.length];
}

export const inviteCollabConnFn = createServerFn({ method: "POST" })
  .validator((d: { token: string; name?: string }) => d)
  .handler(
    async ({ data }): Promise<{ ok: true; conn: GuestConn } | { ok: false; error: string }> => {
      await (await import("./schema.server")).ensureSchema().catch(() => {});

      const { resolverInvitacion, marcarInvitacionUsada } = await import("./doc-invites");
      const r = await resolverInvitacion(data.token);
      // Vencida se DICE (quien llegó tarde puede pedir otra); revocada e inexistente se
      // ven igual, que ahí el silencio sí es deliberado.
      if (r.estado === "vencida") {
        return {
          ok: false,
          error: "este acceso venció. Pídele a quien te invitó que te mande uno nuevo.",
        };
      }
      if (r.estado === "no") return { ok: false, error: "esta invitación ya no está disponible" };
      const inv = r.inv;

      const wsUrl = process.env.COLLAB_SIDECAR_WS_URL?.replace(/\/$/, "");
      if (!wsUrl) return { ok: false, error: "co-edición no configurada" };

      const db = await import("../db.server");
      const doc = await db.getDoc(inv.documentId);
      if (!doc) return { ok: false, error: "el documento ya no existe" };

      // Identidad anclada al CORREO invitado, no a lo que se teclee.
      const sub = `invite:${inv.email}`;
      const nombre = (data.name ?? "").trim().slice(0, 40) || inv.name || inv.email.split("@")[0];

      let token: string;
      try {
        const { mintCollabTicket } = await import("./collab-ticket.server");
        // El ticket NO puede durar más que la invitación: si vence a las 6, a las 7 no
        // debe seguir dentro de la sala con un ticket firmado de 12 horas.
        const restante =
          inv.expiresAt != null
            ? Math.max(60, inv.expiresAt - Math.floor(Date.now() / 1000))
            : undefined;
        token = mintCollabTicket(
          {
            doc: inv.documentId,
            sub,
            name: nombre,
            avatar: "",
            color: colorFor(sub),
            role: inv.role,
          },
          restante
        );
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }

      await marcarInvitacionUsada(inv.id, nombre);

      const { seedHtmlFor } = await import("./collab");
      const root = await db.shareRootFor(inv.documentId);
      const initialHtml = await seedHtmlFor(doc.md ?? null);

      return {
        ok: true,
        conn: {
          wsUrl,
          room: inv.documentId,
          token,
          title: root?.title ?? "Documento",
          initialHtml,
          user: { sub, name: nombre, avatar: "", color: colorFor(sub) },
          role: inv.role,
        },
      };
    }
  );
