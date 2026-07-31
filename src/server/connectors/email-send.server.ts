// Envío de correo POR EL AGENTE — la implementación de la tool `email_send`.
//
// Nació el 2026-07-31: en un hilo de trabajo real ("manda el contrato al correo
// rh.juridico@hotmail.com") Ghosty contestó, correctamente, que no tenía cómo. SES ya estaba
// cableado del lado servidor para las notificaciones del producto; lo que faltaba era
// exponerlo, y hacerlo sin convertirlo en una máquina de spam con nuestro dominio.
//
// Vive aparte de `native.server.ts` porque es la única tool nativa con efectos IRREVERSIBLES
// fuera del producto: un correo enviado no se edita ni se borra. Todo lo de este archivo es
// contención de eso.
import type { ToolDest } from "./tool-token.server";

/** Igual que `cleanCc`: valida, dedup y topa. Un canal a terceros no es una lista de difusión. */
const MAX_DEST = 5;
/** Correos por usuario y por hora. Alto para el uso legítimo, bajo para una campaña. */
const MAX_POR_HORA = 20;
const WINDOW_S = 3600;

export type EmailArgs = {
  to?: unknown;
  subject?: unknown;
  body?: unknown;
  attachDoc?: unknown;
};

function direcciones(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
  const ok = arr
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim().toLowerCase())
    .filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(x));
  return Array.from(new Set(ok)).slice(0, MAX_DEST);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  );
}

/**
 * Cuerpo → HTML. Deliberadamente TONTO: párrafos y saltos de línea, nada más.
 *
 * No se pasa por un renderer de markdown y menos por HTML del modelo. El texto lo escribe un
 * LLM y sale del producto con nuestro dominio en el `From`: si pudiera emitir etiquetas,
 * `email_send` sería un inyector de HTML arbitrario firmado por nosotros. Un correo de
 * trabajo se lee igual de bien en párrafos.
 */
function cuerpoHtml(texto: string, firma: string): string {
  const parrafos = texto
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
  return `<!doctype html><html><body style="margin:0;padding:28px 12px;background:#f5f5f7">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:540px;margin:0 auto;background:#fff;border:1px solid #e6e6ea;border-radius:16px">
    <tr><td style="padding:24px 26px;font:400 15px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;color:#1c1c1f">${parrafos}</td></tr>
    <tr><td style="padding:0 26px 22px;font:400 12px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#8a8a94;border-top:1px solid #f0f0f3;padding-top:14px">
      ${escapeHtml(firma)}
    </td></tr>
  </table>
</body></html>`;
}

/**
 * Rate limit en la DB del tenant, reusando `gt_form_rate` (que es genérica por
 * `form_id`/`bucket`). En memoria no serviría: no sobrevive un deploy ni vale con dos
 * procesos — el mismo razonamiento que en el submit de formularios.
 */
async function dentroDelLimite(sub: string): Promise<boolean> {
  const windowStart = Math.floor(Date.now() / 1000 / WINDOW_S) * WINDOW_S;
  try {
    const { dbq, num } = await import("../../dbq.server");
    const rows = await dbq(
      `INSERT INTO gt_form_rate (form_id, bucket, window_start, count) VALUES ('tool:email_send',?,?,1)
       ON CONFLICT(form_id, bucket, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
      [sub, windowStart]
    );
    return num(rows[0]?.count) <= MAX_POR_HORA;
  } catch (e) {
    // Aquí NO se deja pasar, al revés que en el formulario público: allá el coste de fallar
    // cerrado es perder el intake de un cliente; aquí es que el agente reintente.
    console.error("[email_send] rate check falló", e);
    return false;
  }
}

/** Bitácora append-only. Un envío saliente sin rastro es indefendible ante un reporte de abuso. */
async function bitacora(row: {
  sub: string;
  to: string[];
  subject: string;
  attached: string | null;
  ok: boolean;
}) {
  try {
    const { dbq } = await import("../../dbq.server");
    await dbq(
      `INSERT INTO gt_email_log (sub, to_addrs, subject, attached, ok, created_at)
       VALUES (?,?,?,?,?,?)`,
      [row.sub, row.to.join(","), row.subject.slice(0, 300), row.attached, row.ok ? 1 : 0, Math.floor(Date.now() / 1000)]
    );
  } catch (e) {
    console.error("[email_send] bitácora falló", e);
  }
}

/**
 * Bytes del documento DE ESTA conversación, sin pasar por HTTP.
 *
 * El `documentId` NUNCA viene por argumento: se resuelve desde el `dest` firmado en el
 * tool-token, igual que hacen las tools de comentarios. Un id libre convertiría esto en un
 * lector —y peor, un exfiltrador por correo— de documentos ajenos.
 */
async function adjuntoDelTurno(
  dest: ToolDest | null,
  sub: string,
  formato: "docx" | "pdf"
): Promise<{ bytes: Buffer; fileName: string; mime: string } | { error: string }> {
  const db = await import("../../db.server");
  const documentId = dest?.dmId
    ? await db.getDmArtifact(dest.dmId)
    : dest?.channelId
      ? await db.getThreadArtifact(dest.channelId, null)
      : null;
  if (!documentId) return { error: "no hay ningún documento en esta conversación para adjuntar" };

  const { resolveExportDoc, docBlocks } = await import("../doc-access.server");
  // `isOwner:false` es lo conservador: el permiso sigue resolviéndose por dueño o por el room
  // del artefacto. Aquí no hay request del que sacar la sesión, sólo el `sub` del token.
  const doc = await resolveExportDoc(documentId, null, { sub, isOwner: false });
  if (!doc) return { error: "no tienes acceso a ese documento" };
  if (formato === "pdf" && doc.kind !== "doc") {
    return { error: "sólo los documentos de prosa se pueden mandar como PDF; usa docx" };
  }
  const blocks = await docBlocks(doc.md);
  const titulo = doc.title || "Documento";
  const base = titulo.replace(/[\\/:*?"<>|]/g, "-").slice(0, 80);
  const ex = await import("../doc-export.server");
  if (formato === "docx") {
    return { bytes: await ex.blocksToDocx(blocks, titulo), fileName: `${base}.docx`,
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  }
  const html = await ex.blocksToPrintHtml(blocks, titulo);
  const pdf = await ex.htmlToPdf(html);
  // `htmlToPdf` devuelve null si el render falla o tarda demasiado (despierta una caja).
  // Decirlo es obligatorio: un "ya lo mandé" sin PDF es peor que un error.
  if (!pdf) return { error: "el servicio de PDF no respondió; intenta de nuevo o manda el .docx" };
  return { bytes: pdf, fileName: `${base}.pdf`, mime: "application/pdf" };
}

export async function enviarCorreo(sub: string, args: EmailArgs, dest: ToolDest | null) {
  const to = direcciones(args.to);
  if (!to.length) return { ok: false, error: "falta al menos una dirección válida en `to`" };
  const subject = String(args.subject ?? "").trim().slice(0, 200);
  if (!subject) return { ok: false, error: "falta el asunto" };
  const body = String(args.body ?? "").trim();
  if (!body) return { ok: false, error: "falta el cuerpo del correo" };

  const { sesConfigured, sendSesEmail } = await import("../ses.server");
  // Sin creds, `sendSesEmail` es un no-op que devuelve false — decir "listo" ahí sería
  // mentir con toda la confianza del mundo.
  if (!sesConfigured()) return { ok: false, error: "el correo no está configurado en este workspace" };

  if (!(await dentroDelLimite(sub))) {
    return { ok: false, error: `tope de ${MAX_POR_HORA} correos por hora alcanzado; inténtalo más tarde` };
  }

  const formato = args.attachDoc === "docx" || args.attachDoc === "pdf" ? args.attachDoc : null;
  let adjunto: { bytes: Buffer; fileName: string; mime: string } | null = null;
  if (formato) {
    const r = await adjuntoDelTurno(dest, sub, formato);
    if ("error" in r) return { ok: false, error: r.error };
    adjunto = r;
  }

  // Quién manda: el remitente sigue siendo el dominio del producto (SES sólo firma lo que
  // tiene verificado), pero el Reply-To es la persona que lo pidió. Sin eso, la respuesta
  // del destinatario cae en noreply@ y se pierde — en un trámite legal eso es el trabajo.
  const db = await import("../../db.server");
  const [yo] = await db.emailsForSubsAny([sub]);
  const firma = yo?.name
    ? `Enviado por ${yo.name} desde Ghosty Teams.`
    : "Enviado desde Ghosty Teams.";

  const ok = await sendSesEmail({
    to,
    subject,
    html: cuerpoHtml(body, firma),
    text: `${body}\n\n—\n${firma}`,
    replyTo: yo?.email,
    attachments: adjunto ? [{ fileName: adjunto.fileName, bytes: adjunto.bytes, mime: adjunto.mime }] : undefined,
  });
  await bitacora({ sub, to, subject, attached: adjunto?.fileName ?? null, ok });
  if (!ok) {
    return {
      ok: false,
      error: adjunto
        ? "no se pudo enviar (¿el adjunto pasa de 10MB?); revisa y dilo tal cual al usuario"
        : "no se pudo enviar el correo",
    };
  }
  return { ok: true, to, subject, attached: adjunto?.fileName ?? null };
}
