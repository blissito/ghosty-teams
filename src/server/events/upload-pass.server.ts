// El PASE de un archivo subido por un invitado.
//
// ⚠️ Sin esto, `eventPostFn` tendría que creerle al cliente qué `fileId` adjunta. Un
// `fileId` es opaco, pero "opaco" no es "secreto": basta conocer el de otro sitio para
// colgarlo en este room, y entonces un invitado publicaría un archivo que no subió él.
//
// El pase ata tres cosas —el archivo, QUIÉN lo subió y a QUÉ room— con una firma que sólo
// puede emitir el servidor. Se verifica al publicar el mensaje.
//
// Un miembro no lo necesita: su camino pasa por la sesión, que ya dice quién es.
import crypto from "node:crypto";

function secreto(): string {
  return process.env.EVENT_TICKET_SECRET ?? process.env.SESSION_SECRET ?? "";
}

const canonico = (fileId: string, sub: string, channelId: number) => `${fileId}.${sub}.${channelId}`;

export async function signUploadPass(fileId: string, sub: string, channelId: number): Promise<string> {
  return crypto.createHmac("sha256", secreto()).update(canonico(fileId, sub, channelId)).digest("hex");
}

/** Comparación en tiempo constante: el atacante controla el pase y puede medir. */
export async function verifyUploadPass(
  pass: string | undefined,
  fileId: string,
  sub: string,
  channelId: number
): Promise<boolean> {
  if (!pass) return false;
  const esperado = await signUploadPass(fileId, sub, channelId);
  const a = Buffer.from(pass, "utf8");
  const b = Buffer.from(esperado, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
