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
  /** Unix. `null` = sin caducidad. Al vencer, el acceso se pierde con aviso. */
  expiresAt: number | null;
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

/**
 * Origen del enlace de invitación. Tiene que llevar el SUBDOMINIO DEL EQUIPO
 * (`business.teams.ghosty.studio`), no el genérico: el tenant se resuelve por subdominio
 * (`tenant.server.ts`), así que un enlace a `teams.ghosty.studio` cae en otro namespace y
 * la invitación "no existe". Pasó en producción con una invitación real.
 *
 * Por eso se toma del HOST DE ESTA PETICIÓN —que ya viene con el subdominio correcto— y
 * `GTEAMS_PUBLIC_ORIGIN` queda sólo como último recurso.
 */
async function origenDelEquipo(): Promise<string> {
  try {
    const { getRequestHeader, getRequestHost, getRequestProtocol } = await import(
      "@tanstack/react-start/server"
    );
    const host = getRequestHeader("x-forwarded-host") || getRequestHost();
    if (host) {
      const proto = getRequestHeader("x-forwarded-proto") || getRequestProtocol() || "https";
      return `${proto}://${host}`.replace(/\/$/, "");
    }
  } catch {
    /* fuera de una petición (cron, script) → al env */
  }
  return (process.env.GTEAMS_PUBLIC_ORIGIN ?? "").replace(/\/$/, "");
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
      `SELECT id, email, name, role, created_at, used_at, revoked_at, expires_at
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
      expiresAt: r.expires_at ? num(r.expires_at) : null,
    }));
  });

/**
 * NÚCLEO de invitar — sin sesión y sin request, para poder llamarlo desde donde no hay
 * ninguna de las dos.
 *
 * Lo usan el serverFn de la UI (con la sesión) y la tool `doc_share` del agente (con el `sub`
 * del tool-token). El permiso se comprueba IGUAL en los dos caminos —`resolveDocRole` debe
 * dar `edit`—, que es exactamente lo que hacía `requireEditor`: invitar es repartir acceso, y
 * eso no se relaja porque el llamador sea un agente.
 */
export async function invitarADoc(o: {
  documentId: string;
  email: string;
  role: DocRole;
  porSub: string;
  porNombre: string;
  porIsOwner?: boolean;
  /** Copy de quien invita ("revisa las cláusulas de plazo antes del viernes"). Se escapa. */
  mensaje?: string;
  /** Unix. El acceso se apaga solo al llegar la fecha; `null`/ausente = sin caducidad. */
  expiresAt?: number | null;
}): Promise<{ ok: true; invite: DocInvite; enviado: boolean; url: string } | { ok: false; error: string }> {
  await (await import("./schema.server")).ensureSchema().catch(() => {});

  const { resolveDocRole } = await import("./doc-access.server");
  const mio = await resolveDocRole(o.documentId, { sub: o.porSub, isOwner: !!o.porIsOwner });
  if (mio !== "edit") return { ok: false, error: "no puedes invitar a este documento" };

  const email = normalizarCorreo(o.email);
  if (!correoValido(email)) return { ok: false, error: "ese correo no se ve bien" };
  const role: DocRole = o.role ?? "edit";

  const { dbq, num } = await import("../dbq.server");
  // Re-invitar al mismo correo REEMPLAZA la invitación anterior en vez de acumular
  // ligas vivas: cada token que sigue funcionando es una puerta más que vigilar.
  await dbq(
    `UPDATE gc_doc_invites SET revoked_at = unixepoch()
      WHERE document_id = ? AND email = ? AND revoked_at IS NULL`,
    [o.documentId, email]
  );

  // Una fecha ya pasada casi siempre es un dedazo: crear una invitación nacida muerta
  // sería peor que decirlo.
  const expiresAt = o.expiresAt ?? null;
  if (expiresAt != null && expiresAt <= Math.floor(Date.now() / 1000)) {
    return { ok: false, error: "esa fecha ya pasó" };
  }

  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  await dbq(
    `INSERT INTO gc_doc_invites (document_id, email, role, token, invited_by, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [o.documentId, email, role, token, o.porSub, expiresAt]
  );
  const rows = await dbq(`SELECT id, created_at FROM gc_doc_invites WHERE token = ?`, [token]);

  const url = `${await origenDelEquipo()}/coeditar/invitacion/${token}`;

  // El título se lee del documento, no lo manda el cliente: menos superficie y
  // siempre coincide con lo que la persona va a abrir.
  const root = await (await import("../db.server")).shareRootFor(o.documentId);

  const enviado = await mandarCorreo({
    para: email,
    deQuien: o.porNombre || "Alguien",
    titulo: root?.title || "un documento",
    role,
    url,
    mensaje: o.mensaje,
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
      expiresAt,
    },
  };
}

export const inviteToDocFn = createServerFn({ method: "POST" })
  .validator(
    (d: { documentId: string; email: string; role?: DocRole; expiresAt?: number | null }) => d
  )
  .handler(
    async ({ data }): Promise<{ ok: true; invite: DocInvite; enviado: boolean; url: string } | { ok: false; error: string }> => {
      const me = await meOrThrow();
      return invitarADoc({
        documentId: data.documentId,
        email: data.email,
        role: data.role ?? "edit",
        porSub: me.sub,
        porNombre: me.name || me.email || "Alguien",
        porIsOwner: me.isOwner,
        expiresAt: data.expiresAt ?? null,
      });
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

export type Invitacion = {
  documentId: string;
  email: string;
  name: string | null;
  role: DocRole;
  id: number;
  expiresAt: number | null;
};

/**
 * Invitación por su token.
 *
 * VENCIDA se distingue de INEXISTENTE a propósito: quien recibió una invitación real y
 * llegó tarde merece saber que llegó tarde, para pedir otra. Revocada e inexistente sí se
 * ven igual — ahí el silencio es deliberado.
 */
export async function resolverInvitacion(
  token: string
): Promise<{ estado: "ok"; inv: Invitacion } | { estado: "vencida" } | { estado: "no" }> {
  const { dbq, num } = await import("../dbq.server");
  const rows = await dbq(
    `SELECT id, document_id, email, name, role, expires_at FROM gc_doc_invites
      WHERE token = ? AND revoked_at IS NULL LIMIT 1`,
    [token]
  );
  const r = rows[0];
  if (!r) return { estado: "no" };
  const expiresAt = r.expires_at ? num(r.expires_at) : null;
  if (expiresAt != null && expiresAt <= Math.floor(Date.now() / 1000)) return { estado: "vencida" };
  return {
    estado: "ok",
    inv: {
      id: num(r.id),
      documentId: r.document_id ?? "",
      email: r.email ?? "",
      name: r.name ?? null,
      role: (r.role as DocRole) ?? "edit",
      expiresAt,
    },
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

// El verbo va como CLAVE del diccionario, no como texto suelto: se interpola en el asunto
// y en el encabezado, así que las tres frases completas tienen que existir en los dos
// idiomas o el correo saldría mitad y mitad.
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
  /** Lo que quien invita quiere decirle. Va como prosa ESCAPADA por la plantilla. */
  mensaje?: string;
}): Promise<boolean> {
  try {
    const { sendSesEmail, sesConfigured } = await import("./ses.server");
    if (!sesConfigured()) return false;
    const accion = VERBO[o.role];
    // Idioma de QUIEN INVITA: el destinatario no tiene cuenta, así que no hay preferencia
    // suya que consultar. Se resuelve aquí, dentro del request de la invitación.
    const { currentLocale } = await import("./locale.server");
    const { translate } = await import("../i18n.core");
    const locale = await currentLocale();
    const tr = (k: string, p?: Record<string, string>) => translate(locale, k, p);

    // La plantilla COMÚN de Ghosty (globo, mascota incrustada, pie). Antes esto armaba su
    // propio HTML a mano y llegaba un correo pelón, sin el personaje ni el pie: distinto
    // de todo lo demás que manda el producto justo en el correo que abre alguien de FUERA.
    const { ghostyEmail } = await import("./email-template.server");
    const { html, text, inline } = ghostyEmail({
      head: tr("{deQuien} te invitó a {accion} un documento", { deQuien: o.deQuien, accion: tr(accion) }),
      // El mensaje de quien invita va PRIMERO: "revisa las cláusulas de plazo antes del
      // viernes" es lo que hace que el correo se lea y se atienda. El aviso del enlace va
      // al final, que es letra chica.
      body: [o.titulo, o.mensaje?.trim(), tr("No necesitas crear una cuenta: este enlace es tuyo y te identifica. No se lo reenvíes a nadie.")]
        .filter(Boolean)
        .join("\n\n"),
      cta: { label: tr("Abrir el documento"), url: o.url },
      // Va a gente de FUERA del workspace: su pie dice quién escribe y no promete unos
      // ajustes de notificaciones que esa persona no tiene.
      footer: "externo",
      locale,
      deQuien: o.deQuien,
    });

    return await sendSesEmail({
      to: o.para,
      subject: tr('{deQuien} te invitó a {accion} "{titulo}"', { deQuien: o.deQuien, accion: tr(accion), titulo: o.titulo }),
      html,
      text,
      inline,
    });
  } catch (e) {
    // Que el correo falle no debe perder la invitación: el enlace ya existe y quien
    // invita puede copiarlo a mano (por eso la server fn devuelve `url`).
    console.error("[invite] correo falló:", (e as Error).message);
    return false;
  }
}
