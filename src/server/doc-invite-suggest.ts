import { createServerFn } from "@tanstack/react-start";

// Sugerencias para invitar: la gente del workspace primero.
//
// Invitar por correo se hizo para los de AFUERA, pero el caso más común es de adentro —
// "compártelo con Brendi" — y obligar a teclear de memoria el correo de un compañero es
// pedirle al usuario un dato que la app ya tiene. El padrón manda (`workspaceRoster`,
// que vive en ghosty.studio) y `gc_users` pone la cara y el nombre de quien ya entró.
//
// El mecanismo de invitación NO cambia: sigue siendo el enlace tokenizado al correo. Esto
// sólo evita el dedazo.

export type Invitable = {
  sub: string;
  name: string;
  email: string;
  avatar: string;
  /** Ya tiene una invitación viva a este documento. */
  invitado: boolean;
};

export const suggestInviteesFn = createServerFn({ method: "POST" })
  .validator((d: { documentId: string }) => d)
  .handler(async ({ data }): Promise<Invitable[]> => {
    const { useSession } = await import("@tanstack/react-start/server");
    const { sessionConfig } = await import("./session.server");
    const s = await useSession<{ user?: import("../users.server").SessionUser }>(
      sessionConfig()
    );
    const me = s.data.user;
    if (!me) return [];

    // Mismo permiso que invitar: si no puedes invitar, no ves el padrón por esta puerta.
    const { resolveDocRole } = await import("./doc-access.server");
    const role = await resolveDocRole(data.documentId, { sub: me.sub, isOwner: me.isOwner });
    if (role !== "edit") return [];

    const { workspaceRoster } = await import("./roster.server");
    const { dbq } = await import("../dbq.server");

    const [padron, perfiles, invitados] = await Promise.all([
      workspaceRoster().catch(() => []),
      dbq("SELECT sub, name, email, avatar FROM gc_users WHERE COALESCE(banned,0)=0").catch(
        () => [] as Awaited<ReturnType<typeof dbq>>
      ),
      dbq(
        `SELECT email FROM gc_doc_invites WHERE document_id = ? AND revoked_at IS NULL`,
        [data.documentId]
      ).catch(() => [] as Awaited<ReturnType<typeof dbq>>),
    ]);

    const yaInvitados = new Set(
      invitados.map((r) => (r.email ?? "").toLowerCase()).filter(Boolean)
    );
    const porSub = new Map(perfiles.map((r) => [r.sub ?? "", r]));

    const out: Invitable[] = [];
    const vistos = new Set<string>();

    // El padrón es la fuente de verdad de QUIÉN pertenece; `gc_users` sólo adorna. Al
    // revés se perdía a quien todavía no ha abierto Teams (ver roster.server.ts).
    for (const m of padron) {
      const perfil = porSub.get(m.sub);
      const email = (m.email || perfil?.email || "").toLowerCase();
      if (!email || email === (me.email ?? "").toLowerCase()) continue;
      if (vistos.has(email)) continue;
      vistos.add(email);
      out.push({
        sub: m.sub,
        name: perfil?.name || email.split("@")[0],
        email,
        avatar: perfil?.avatar || "",
        invitado: yaInvitados.has(email),
      });
    }

    // Quien está en `gc_users` pero no en el padrón (hipo de ghosty.studio, cuenta vieja):
    // se ofrece igual. Peor caso, la invitación no le sirve; mejor caso, no se cae la lista
    // porque el IdP tosió.
    for (const r of perfiles) {
      const email = (r.email ?? "").toLowerCase();
      if (!email || vistos.has(email) || email === (me.email ?? "").toLowerCase()) continue;
      vistos.add(email);
      out.push({
        sub: r.sub ?? "",
        name: r.name || email.split("@")[0],
        email,
        avatar: r.avatar || "",
        invitado: yaInvitados.has(email),
      });
    }

    return out.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 50);
  });
