// `doc_share` — el agente da ACCESO a un documento y escribe el correo que lo explica.
//
// Nació el 2026-07-31, del mismo hilo que `email_send`. Adjuntar un .docx suelto es lo que se
// hacía cuando no había nada mejor: el destinatario no sabe si es la versión buena, no puede
// comentar, y lo que devuelva hay que reintegrarlo a mano. Toda la maquinaria de co-edición
// —roles, invitación nominal por token, correo— ya existía; lo único que faltaba era que el
// agente la alcanzara.
//
// Es la tool más delicada del producto: no manda información, reparte una LLAVE. Por eso
// comparte contención con `email_send` (tope por hora, bitácora, máx 5 destinatarios) y añade
// la suya: el permiso se comprueba contra el documento, no contra la buena fe del modelo.
import type { ToolDest } from "./tool-token.server";
import type { DocRole } from "../../db.server";

const MAX_DEST = 5;

export type ShareArgs = { to?: unknown; role?: unknown; message?: unknown };

function direcciones(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
  const ok = arr
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim().toLowerCase())
    .filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(x));
  return Array.from(new Set(ok)).slice(0, MAX_DEST);
}

export async function compartirDoc(sub: string, args: ShareArgs, dest: ToolDest | null) {
  const to = direcciones(args.to);
  if (!to.length) return { ok: false, error: "falta al menos una dirección válida en `to`" };
  // Por defecto COMENTAR, no editar. El caso normal es "que lo revise", y un nivel de más no
  // se nota hasta que alguien reescribe un contrato sin querer. Subirlo es explícito.
  const role: DocRole = args.role === "view" || args.role === "edit" ? args.role : "comment";
  const message = typeof args.message === "string" ? args.message.trim().slice(0, 800) : undefined;

  const { documentoDelTurno } = await import("./conv-doc.server");
  const documentId = await documentoDelTurno(dest);
  if (!documentId) return { ok: false, error: "no hay ningún documento en esta conversación para compartir" };

  const { sesConfigured } = await import("../ses.server");
  // Sin SES la invitación se crea igual y queda la URL, pero nadie se entera: para el agente
  // eso NO es éxito. Que lo diga antes de repartir accesos que nadie va a poder usar.
  if (!sesConfigured()) return { ok: false, error: "el correo no está configurado en este workspace" };

  const { dentroDelLimite, bitacora } = await import("./email-send.server");
  if (!(await dentroDelLimite(sub, "tool:doc_share"))) {
    return { ok: false, error: "alcanzaste el tope de envíos por hora; inténtalo más tarde" };
  }

  const db = await import("../../db.server");
  const [yo] = await db.emailsForSubsAny([sub]);
  const { invitarADoc } = await import("../doc-invites");

  const hechas: { email: string; url: string; enviado: boolean }[] = [];
  const fallidas: { email: string; error: string }[] = [];
  for (const email of to) {
    const r = await invitarADoc({
      documentId,
      email,
      role,
      porSub: sub,
      porNombre: yo?.name || yo?.email || "Alguien",
      mensaje: message,
    });
    if (r.ok) hechas.push({ email, url: r.url, enviado: r.enviado });
    else fallidas.push({ email, error: r.error });
  }
  await bitacora({
    sub,
    to: hechas.map((h) => h.email),
    subject: `doc_share ${role} · ${documentId}`,
    attached: null,
    ok: hechas.length > 0,
  });

  if (!hechas.length) {
    // Todas fallaron por la misma razón casi siempre (no eres editor del documento).
    return { ok: false, error: fallidas[0]?.error || "no se pudo compartir" };
  }
  return {
    ok: true,
    role,
    compartido: hechas,
    fallidas: fallidas.length ? fallidas : undefined,
    // Que el agente lo diga: no hay caducidad. `gc_doc_invites` sólo se cierra revocando, y
    // un acceso permanente repartido sin que nadie lo sepa es el fallo que hay que evitar.
    nota: "El acceso queda vigente hasta que lo revoques desde el diálogo de Compartir del documento.",
  };
}
