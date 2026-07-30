// Token del formulario público. Calcado de tool-token.server.ts, pero con un trabajo
// distinto y más humilde.
//
// NO es autenticación: el token viaja dentro del HTML de un formulario público, así que
// cualquiera que abra la liga lo tiene. Su único trabajo es transportar el NAMESPACE del
// tenant hasta el endpoint de submit **sin que se pueda manipular**.
//
// Hace falta porque el formulario se sirve desde el host de artefactos
// (artefacto.ghosty.studio) y desde un iframe de origen opaco: ahí `slugFromHost` no
// resuelve nada y `currentNamespace()` caería a `SQLD_NAMESPACE`, o sea al tenant
// equivocado. Ése es exactamente el bug del webhook de EasyBits que esto reemplaza.
//
// ¿Por qué firmado y no `?ns=acme` en claro? Funcionaría igual para el camino feliz, pero
// dejaría que cualquiera dirigiera submits a namespaces ajenos (basura cross-tenant y
// enumeración de workspaces). Firmar sale gratis.
//
// SIN expiración: las ligas se reparten por correo y WhatsApp y tienen que seguir vivas
// meses después. Para cerrar un formulario se usa `status='closed'` en su fila, no la
// caducidad del token — rotarlo mataría en silencio los links ya entregados.
import crypto from "node:crypto";

function secret(): string {
  const s = process.env.GHOSTY_PARTNER_SECRET;
  if (!s) throw new Error("GHOSTY_PARTNER_SECRET no configurado");
  return s;
}

export type FormRef = { id: string; ns: string };

export function mintFormToken(ref: FormRef): string {
  const payload = Buffer.from(JSON.stringify(ref)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyFormToken(token: string): FormRef | null {
  const [payload, sig] = (token || "").split(".");
  if (!payload || !sig) return null;
  const expect = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString()) as Partial<FormRef>;
    if (!p.id || !p.ns) return null;
    return { id: p.id, ns: p.ns };
  } catch {
    return null;
  }
}
