import { SESClient, SendEmailCommand, SendRawEmailCommand } from "@aws-sdk/client-ses";

// ── Correo transaccional/notificaciones vía AWS SES ──────────────────────────
// Misma receta que easybits/fixter2025 (SDK v1 SendEmailCommand). Dominio
// `ghosty.studio` verificado (Easy DKIM) en la cuenta [easybits], región us-east-1.
// Creds: SES_KEY/SES_SECRET (+ SES_REGION, def us-east-1). Sin creds → no-op (log).
const REGION = process.env.SES_REGION || "us-east-1";
const KEY = process.env.SES_KEY;
const SECRET = process.env.SES_SECRET;
const FROM = process.env.SES_FROM || "Ghosty <noreply@ghosty.studio>";

let client: SESClient | null = null;
function ses(): SESClient | null {
  if (!KEY || !SECRET) return null;
  client ??= new SESClient({ region: REGION, credentials: { accessKeyId: KEY, secretAccessKey: SECRET } });
  return client;
}
export function sesConfigured(): boolean {
  return !!(KEY && SECRET);
}

/**
 * Imagen INCRUSTADA en el correo (cid:), no enlazada.
 *
 * Una imagen remota cuesta una petición que el destinatario paga al abrir: medido el
 * 2026-07-29, 500ms contra el origen (330 de handshake TLS a Europa) y encima Gmail
 * revalidaba en cada apertura porque el asset iba con `max-age=0`. Incrustada no hay red:
 * el mascot pesa 1.5KB, menos que los headers de esa petición.
 */
export type InlineImage = { cid: string; bytes: Buffer; mime: string; fileName: string };

/** Cabecera MIME con acentos/emoji → RFC 2047. Sin esto el asunto llega como mojibake. */
function mimeWord(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

const wrap = (b64: string) => (b64.match(/.{1,76}/g) ?? []).join("\r\n");

export async function sendSesEmail(opts: {
  to: string | string[];
  subject: string;
  html: string;
  from?: string;
  replyTo?: string;
  /** Si vienen, el correo se manda como multipart/related y el HTML las cita con cid:. */
  inline?: InlineImage[];
  /** Versión en texto plano. Un correo SÓLO-html es una de las señales que Gmail lee
   *  como publicidad (y hay clientes que ni siquiera muestran html). */
  text?: string;
}): Promise<boolean> {
  const c = ses();
  if (!c) return false; // sin creds → no-op (correo apagado)
  const toList = Array.isArray(opts.to) ? opts.to : [opts.to];
  const from = opts.from || FROM;
  if (opts.inline?.length) {
    // multipart/related: el HTML primero, las imágenes después, referidas por Content-ID.
    const b = `gt_${Date.now().toString(36)}`;
    const head = [
      `From: ${from}`,
      `To: ${toList.join(", ")}`,
      opts.replyTo ? `Reply-To: ${opts.replyTo}` : null,
      `Subject: ${mimeWord(opts.subject)}`,
      "MIME-Version: 1.0",
      // Correo GENERADO, no una campaña: se lo decimos explícitamente a los filtros, y de
      // paso evitamos respuestas automáticas (fuera-de-oficina) contra noreply@.
      "Auto-Submitted: auto-generated",
      "X-Auto-Response-Suppress: All",
      // `type` = qué es la parte RAÍZ del related. Sin él, al anidar el multipart/alternative
      // (para el texto plano) Gmail dejó de resolver los cid: y volvió a pedir la imagen por
      // red — la mejora del texto plano se comió la de la imagen incrustada.
      `Content-Type: multipart/related; boundary="${b}"${opts.text ? '; type="multipart/alternative"' : '; type="text/html"'}`,
    ].filter(Boolean).join("\r\n");
    // Estructura: related( alternative( text/plain, text/html ), imágenes ). El plano va
    // PRIMERO por el contrato de multipart/alternative: el cliente elige la ÚLTIMA parte
    // que sepa mostrar, así que el html es el que gana donde se puede.
    const ab = `alt_${b}`;
    const alt = opts.text
      ? [
          `--${b}`,
          `Content-Type: multipart/alternative; boundary="${ab}"`,
          "",
          `--${ab}`,
          "Content-Type: text/plain; charset=UTF-8",
          "Content-Transfer-Encoding: base64",
          "",
          wrap(Buffer.from(opts.text, "utf8").toString("base64")),
          `--${ab}`,
          "Content-Type: text/html; charset=UTF-8",
          "Content-Transfer-Encoding: base64",
          "",
          wrap(Buffer.from(opts.html, "utf8").toString("base64")),
          `--${ab}--`,
        ]
      : [
          `--${b}`,
          "Content-Type: text/html; charset=UTF-8",
          "Content-Transfer-Encoding: base64",
          "",
          wrap(Buffer.from(opts.html, "utf8").toString("base64")),
        ];
    const parts = [
      ...alt,
      ...opts.inline.flatMap((img) => [
        `--${b}`,
        `Content-Type: ${img.mime}`,
        "Content-Transfer-Encoding: base64",
        `Content-ID: <${img.cid}>`,
        `Content-Disposition: inline; filename="${img.fileName}"`,
        "",
        wrap(img.bytes.toString("base64")),
      ]),
      `--${b}--`,
      "",
    ].join("\r\n");
    try {
      const r = await c.send(new SendRawEmailCommand({ RawMessage: { Data: Buffer.from(`${head}\r\n\r\n${parts}`, "utf8") } }));
      console.log(`[ses] ok ${r.MessageId} → ${toList.join(",")} · inline=${opts.inline.length} · ${opts.subject.slice(0, 60)}`);
      return true;
    } catch (e) {
      console.warn("[ses] raw send falló:", (e as Error)?.message);
      return false;
    }
  }
  try {
    const r = await c.send(new SendEmailCommand({
      Source: from,
      Destination: { ToAddresses: toList },
      ReplyToAddresses: opts.replyTo ? [opts.replyTo] : undefined,
      Message: {
        Subject: { Data: opts.subject, Charset: "UTF-8" },
        Body: { Html: { Data: opts.html, Charset: "UTF-8" } },
      },
    }));
    // MessageId al journal: sin él, "SES lo aceptó" es una afirmación que no se puede
    // comprobar contra AWS, y un correo que no llega no se distingue de uno que sí salió.
    console.log(`[ses] ok ${r.MessageId} → ${toList.join(",")} · from=${opts.from || FROM} · ${opts.subject.slice(0, 60)}`);
    return true;
  } catch (e) {
    console.warn("[ses] send falló:", (e as Error)?.message);
    return false;
  }
}
