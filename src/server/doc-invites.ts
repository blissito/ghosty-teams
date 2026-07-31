import { createServerFn } from "@tanstack/react-start";
import type { DocRole } from "../db.server";

// Invitar por CORREO a co-editar un documento — el segundo nivel de compartir.
//
// El enlace abierto da acceso pero no identidad: quien entra se pone el nombre que
// quiera. Aquí el token viaja a un correo concreto, así que quien lo abre ES esa
// persona. Sin obligarla a crearse cuenta. Es lo que hacen Google (visitor sharing con
// código al correo) y Figma (guests por correo), y lo que hacía falta para que
// "¿quién editó esto?" tenga respuesta.
//
// Los dos niveles conviven a propósito: enlace abierto para lo rápido, invitación
// nominal para lo que va a doler si se atribuye mal.

export type DocInvite = {
  id: number;
  email: string;
  name: string | null;
  role: DocRole;
  createdAt: number;
  usedAt: number | null;
  revoked: boolean;
};

async function meOrThrow() {
  const { useSession } = await import("@tanstack/react-start/server");
  const { sessionConfig } = await import("./session.server");
  const s = await useSession<{ user?: import("../users.server").SessionUser }>(sessionConfig());
  if (!s.data.user) throw new Error("no autorizado");
  return s.data.user;
}

/** Sólo quien puede EDITAR el documento puede invitar a otros. */
async function requireEditor(documentId: string) {
  const me = await meOrThrow();
  const { resolveDocRole } = await import("./doc-access.server");
  const role = await resolveDocRole(documentId, { sub: me.sub, isOwner: me.isOwner });
  if (role !== "edit") throw new Error("no puedes invitar a este documento");
  return me;
}

function normalizarCorreo(v: string): string {
  return v.trim().toLowerCase();
}

// Suficiente para atajar dedazos; validar de más rebota correos legítimos y el correo
// que no llega ya es la señal real de que estaba mal escrito.
function correoValido(v: string): boolean {
  return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(v);
}

export const listDocInvitesFn = createServerFn({ method: "POST" })
  .validator((d: { documentId: string }) => d)
  .handler(async ({ data }): Promise<DocInvite[]> => {
    await (await import("./schema.server")).ensureSchema().catch(() => {});
    await requireEditor(data.documentId);
    const { dbq, num } = await import("../dbq.server");
    const rows = await dbq(
      `SELECT id, email, name, role, created_at, used_at, revoked_at
         FROM gc_doc_invites WHERE document_id = ? ORDER BY id DESC`,
      [data.documentId]
    );
    return rows.map((r) => ({
      id: num(r.id),
      email: r.email ?? "",
      name: r.name ?? null,
      role: (r.role as DocRole) ?? "edit",
      createdAt: num(r.created_at),
      usedAt: r.used_at ? num(r.used_at) : null,
      revoked: !!r.revoked_at,
    }));
  });

export const inviteToDocFn = createServerFn({ method: "POST" })
  .validator((d: { documentId: string; email: string; role?: DocRole }) => d)
  .handler(
    async ({ data }): Promise<{ ok: true; invite: DocInvite; enviado: boolean; url: string } | { ok: false; error: string }> => {
      await (await import("./schema.server")).ensureSchema().catch(() => {});
      const me = await requireEditor(data.documentId);

      const email = normalizarCorreo(data.email);
      if (!correoValido(email)) return { ok: false, error: "ese correo no se ve bien" };
      const role: DocRole = data.role ?? "edit";

      const { dbq, num } = await import("../dbq.server");
      // Re-invitar al mismo correo REEMPLAZA la invitación anterior en vez de acumular
      // ligas vivas: cada token que sigue funcionando es una puerta más que vigilar.
      await dbq(
        `UPDATE gc_doc_invites SET revoked_at = unixepoch()
          WHERE document_id = ? AND email = ? AND revoked_at IS NULL`,
        [data.documentId, email]
      );

      const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
      await dbq(
        `INSERT INTO gc_doc_invites (document_id, email, role, token, invited_by)
         VALUES (?, ?, ?, ?, ?)`,
        [data.documentId, email, role, token, me.sub]
      );
      const rows = await dbq(`SELECT id, created_at FROM gc_doc_invites WHERE token = ?`, [token]);

      const origen = (process.env.GTEAMS_PUBLIC_ORIGIN ?? "").replace(/\/$/, "");
      const url = `${origen}/coeditar/invitacion/${token}`;

      // El título se lee del documento, no lo manda el cliente: menos superficie y
      // siempre coincide con lo que la persona va a abrir.
      const root = await (await import("../db.server")).shareRootFor(data.documentId);

      const enviado = await mandarCorreo({
        para: email,
        deQuien: me.name || me.email || "Alguien",
        titulo: root?.title || "un documento",
        role,
        url,
      });

      return {
        ok: true,
        enviado,
        url,
        invite: {
          id: num(rows[0]?.id ?? null),
          email,
          name: null,
          role,
          createdAt: num(rows[0]?.created_at ?? null),
          usedAt: null,
          revoked: false,
        },
      };
    }
  );

export const revokeDocInviteFn = createServerFn({ method: "POST" })
  .validator((d: { documentId: string; inviteId: number }) => d)
  .handler(async ({ data }) => {
    await requireEditor(data.documentId);
    const { dbq } = await import("../dbq.server");
    // Se marca, no se borra: quedarse sin rastro de a quién se invitó es justo lo que
    // esta tabla vino a resolver.
    await dbq(
      `UPDATE gc_doc_invites SET revoked_at = unixepoch() WHERE id = ? AND document_id = ?`,
      [data.inviteId, data.documentId]
    );
    return { ok: true };
  });

/** Invitación viva por su token, o `null` si no existe, fue revocada o el doc ya no está. */
export async function resolverInvitacion(token: string): Promise<{
  documentId: string;
  email: string;
  name: string | null;
  role: DocRole;
  id: number;
} | null> {
  const { dbq, num } = await import("../dbq.server");
  const rows = await dbq(
    `SELECT id, document_id, email, name, role FROM gc_doc_invites
      WHERE token = ? AND revoked_at IS NULL LIMIT 1`,
    [token]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: num(r.id),
    documentId: r.document_id ?? "",
    email: r.email ?? "",
    name: r.name ?? null,
    role: (r.role as DocRole) ?? "edit",
  };
}

/** Marca la primera entrada y guarda el nombre con el que se presentó. */
export async function marcarInvitacionUsada(id: number, nombre: string): Promise<void> {
  const { dbq } = await import("../dbq.server");
  await dbq(
    `UPDATE gc_doc_invites
        SET used_at = COALESCE(used_at, unixepoch()), name = COALESCE(name, ?)
      WHERE id = ?`,
    [nombre, id]
  );
}

const VERBO: Record<DocRole, string> = {
  view: "ver",
  comment: "comentar",
  edit: "editar",
};

async function mandarCorreo(o: {
  para: string;
  deQuien: string;
  titulo: string;
  role: DocRole;
  url: string;
}): Promise<boolean> {
  try {
    const { sendSesEmail, sesConfigured } = await import("./ses.server");
    if (!sesConfigured()) return false;
    const accion = VERBO[o.role];
    const html = `
<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#171717">
  <p style="font-size:15px;line-height:1.6;margin:0 0 20px">
    <strong>${escapar(o.deQuien)}</strong> te invitó a ${accion} el documento
    <strong>${escapar(o.titulo)}</strong>.
  </p>
  <p style="margin:0 0 24px">
    <a href="${o.url}" style="display:inline-block;background:#171717;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:14px;font-weight:500">
      Abrir el documento
    </a>
  </p>
  <p style="font-size:13px;line-height:1.6;color:#737373;margin:0">
    No necesitas crear una cuenta: este enlace es tuyo y te identifica.
    No se lo reenvíes a nadie.
  </p>
</div>`;
    return await sendSesEmail({
      to: o.para,
      subject: `${o.deQuien} te invitó a ${accion} "${o.titulo}"`,
      html,
      text: `${o.deQuien} te invitó a ${accion} el documento "${o.titulo}".\n\nÁbrelo aquí: ${o.url}\n\nNo necesitas cuenta: este enlace es tuyo y te identifica. No lo reenvíes.`,
    });
  } catch (e) {
    // Que el correo falle no debe perder la invitación: el enlace ya existe y quien
    // invita puede copiarlo a mano (por eso la server fn devuelve `url`).
    console.error("[invite] correo falló:", (e as Error).message);
    return false;
  }
}

function escapar(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
