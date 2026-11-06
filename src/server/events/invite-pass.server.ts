// ── Pase personal a un room abierto: entrar sin teclear correo ni código ─────────────────────
//
// gs lo pone en el correo de quien ya confirmó (hackatón, 6-nov): `/room/<slug>?pase=<token>`.
// Abrir la liga desde su buzón ES la verificación del correo, así que pedirle además el código de
// 6 dígitos sobraba. El token ata el espacio (namespace), el room, el correo y la caducidad, firmado
// con GHOSTY_PARTNER_SECRET (el mismo que ya comparten gs y Teams para `api/internal/*`).
//
//   token = base64url(JSON {w, r, e, n, x}) + "." + hex(HMAC-SHA256(secret, "room-pass." + payload))
//
// ⚠️ Un pase vale para UN correo: si se reenvía, quien lo abra entra con el nombre de otro. Por eso
// caduca (gs lo emite hasta el fin del evento) y el baneo por correo sigue mandando.
import crypto from "node:crypto";

export type RoomPass = { ns: string; room: string; email: string; name: string; exp: number };

const PREFIX = "room-pass.";

function sign(secret: string, payload: string): string {
  return crypto.createHmac("sha256", secret).update(PREFIX + payload).digest("hex");
}

/** Emite un pase (lo usan las pruebas; gs tiene su propia copia en `hackathon/room-pass.ts`). */
export function signRoomPass(p: RoomPass, secret = process.env.GHOSTY_PARTNER_SECRET ?? ""): string {
  const payload = Buffer.from(JSON.stringify({ w: p.ns, r: p.room, e: p.email, n: p.name, x: p.exp })).toString("base64url");
  return `${payload}.${sign(secret, payload)}`;
}

/** El pase si la firma es buena, no caducó y es de ESTE espacio y room; si no, `null`. */
export function verifyRoomPass(
  token: string | null | undefined,
  want: { ns: string; room: string },
  now = Math.floor(Date.now() / 1000),
  secret = process.env.GHOSTY_PARTNER_SECRET ?? "",
): RoomPass | null {
  if (!secret || !token || token.length > 2000) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const a = Buffer.from(token.slice(dot + 1));
  const b = Buffer.from(sign(secret, payload));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let j: { w?: unknown; r?: unknown; e?: unknown; n?: unknown; x?: unknown };
  try {
    j = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof j.e !== "string" || typeof j.r !== "string" || typeof j.w !== "string" || typeof j.x !== "number") return null;
  if (j.x < now || j.w !== want.ns || j.r.toLowerCase() !== want.room.toLowerCase()) return null;
  const email = j.e.trim().toLowerCase();
  if (!email.includes("@")) return null;
  return { ns: j.w, room: j.r, email, name: typeof j.n === "string" ? j.n.trim().slice(0, 60) : "", exp: j.x };
}
