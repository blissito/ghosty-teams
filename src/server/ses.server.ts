import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

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

export async function sendSesEmail(opts: {
  to: string | string[];
  subject: string;
  html: string;
  from?: string;
  replyTo?: string;
}): Promise<boolean> {
  const c = ses();
  if (!c) return false; // sin creds → no-op (correo apagado)
  const toList = Array.isArray(opts.to) ? opts.to : [opts.to];
  try {
    await c.send(new SendEmailCommand({
      Source: opts.from || FROM,
      Destination: { ToAddresses: toList },
      ReplyToAddresses: opts.replyTo ? [opts.replyTo] : undefined,
      Message: {
        Subject: { Data: opts.subject, Charset: "UTF-8" },
        Body: { Html: { Data: opts.html, Charset: "UTF-8" } },
      },
    }));
    return true;
  } catch (e) {
    console.warn("[ses] send falló:", (e as Error)?.message);
    return false;
  }
}
