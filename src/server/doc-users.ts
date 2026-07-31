import { createServerFn } from "@tanstack/react-start";

// Quién es quién dentro de un documento — lo que los comentarios necesitan para poner
// nombre y avatar junto a cada mensaje.
//
// Los hilos guardan sólo el `userId` (nuestro `sub`), no una copia del nombre: si alguien
// se cambia el nombre, sus comentarios viejos no quedan firmados por un fantasma. El
// precio es esta resolución, y por eso existe.
//
// Tres poblaciones conviven en la misma sala, así que hay tres formas de resolver:
//   - miembro del team      → `gc_users`
//   - invitado por correo   → `gc_doc_invites` (`invite:<correo>`)
//   - invitado por liga     → no existe en ninguna tabla; se resuelve con lo que publicó
//                             en el awareness, y si ya se fue, "Invitado"
// El agente entra como `agent:<algo>` y se muestra como Ghosty.

export type DocUser = { id: string; username: string; avatarUrl: string };

export const resolveDocUsersFn = createServerFn({ method: "POST" })
  .validator((d: { documentId: string; ids: string[] }) => d)
  .handler(async ({ data }): Promise<DocUser[]> => {
    const ids = [...new Set(data.ids)].slice(0, 200);
    if (!ids.length) return [];

    const { dbq } = await import("../dbq.server");
    const out = new Map<string, DocUser>();

    const subs = ids.filter((i) => !i.includes(":"));
    if (subs.length) {
      const rows = await dbq(
        `SELECT sub, name, avatar FROM gc_users WHERE sub IN (${subs.map(() => "?").join(",")})`,
        subs
      );
      for (const r of rows) {
        if (!r.sub) continue;
        out.set(r.sub, { id: r.sub, username: r.name || "Alguien", avatarUrl: r.avatar || "" });
      }
    }

    const correos = ids
      .filter((i) => i.startsWith("invite:"))
      .map((i) => i.slice("invite:".length));
    if (correos.length) {
      // Scopeado al documento: el `sub` de una invitación sólo significa algo dentro de
      // la sala donde se invitó.
      const rows = await dbq(
        `SELECT email, name FROM gc_doc_invites
          WHERE document_id = ? AND email IN (${correos.map(() => "?").join(",")})`,
        [data.documentId, ...correos]
      );
      for (const r of rows) {
        const email = r.email ?? "";
        out.set(`invite:${email}`, {
          id: `invite:${email}`,
          username: r.name || email.split("@")[0] || "Invitada",
          avatarUrl: "",
        });
      }
    }

    // Lo que no se pudo resolver igual se devuelve: un comentario sin autor conocido se
    // muestra como invitado, no desaparece.
    for (const id of ids) {
      if (out.has(id)) continue;
      out.set(id, {
        id,
        username: id.startsWith("agent:") ? "Ghosty" : "Invitado",
        avatarUrl: "",
      });
    }

    return [...out.values()];
  });
