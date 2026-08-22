/**
 * ¿Este correo existe?
 *
 * Es lo que hay que correr ANTES de la primera tanda, y no es opcional: una lista scrapeada
 * trae entre 20% y 40% de direcciones muertas, y mandarle a eso desde un dominio recién
 * calentado lo quema en un solo envío. El dominio tarda semanas en calentarse y minutos en
 * arruinarse — verificar es lo único que protege ese trabajo.
 *
 * Tres comprobaciones, en orden de costo. La primera que falla decide:
 *
 *  1. **Sintaxis** — gratis, sin red.
 *  2. **Desechable / de rol** — gratis, contra una lista. `info@`, `noreply@` y los dominios
 *     de correo temporal no rebotan, pero tampoco contesta nadie: gastan cupo y bajan la
 *     tasa de respuesta, que es la señal que los proveedores miran.
 *  3. **MX del dominio** — una consulta DNS. Un dominio sin MX **no puede recibir correo**,
 *     punto. Es donde muere la mayor parte de la basura de una lista scrapeada.
 *
 * ⚠️ **No se hace verificación SMTP** (conectarse al servidor y preguntar por el buzón).
 * Es lo que venden los proveedores de pago, y desde nuestra IP es contraproducente: los
 * servidores grandes responden «existe» a todo (catch-all) o penalizan al que sondea. Lo
 * que sale gratis y sí discrimina es el MX.
 */
import { promises as dns } from "node:dns";

/** Dominios de correo temporal. Quien los usa no quiere que lo encuentren. */
const DESECHABLES = new Set([
  "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com",
  "throwawaymail.com", "yopmail.com", "trashmail.com", "getnada.com",
  "sharklasers.com", "temp-mail.org", "fakeinbox.com", "maildrop.cc",
]);

/**
 * Buzones de ROL: no son de una persona.
 *
 * No se descartan — se MARCAN. `contacto@` es exactamente a quien hay que escribirle en un
 * salón de belleza; `noreply@` no contesta jamás. La diferencia la decide quien manda, no
 * esta función.
 */
const ROL = /^(no-?reply|postmaster|abuse|webmaster|admin|root|hostmaster|mailer-daemon|bounce|notifications?)/i;

export type EmailVerdict =
  | "ok"          // sintaxis buena y el dominio puede recibir correo
  | "rol"         // buzón de rol: se puede mandar, pero es menos probable que conteste
  | "sin_mx"      // el dominio NO puede recibir correo → rebota seguro
  | "desechable"  // correo temporal
  | "sintaxis"    // ni siquiera es una dirección
  | "sin_dominio"; // el dominio no resuelve

export type EmailCheck = { verdict: EmailVerdict; ok: boolean; reason: string };

// Deliberadamente NO es un `^\S+@\S+$`: lo que se busca es descartar basura evidente
// (espacios, sin punto en el dominio, dos arrobas), no validar el RFC 5322 entero — el
// RFC permite direcciones que ningún negocio usa y rechazar por eso perdería contactos.
const SINTAXIS = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** Caché por dominio: en una lista, cientos de filas comparten dominio. */
const mxCache = new Map<string, boolean>();

export async function verifyEmail(raw: string): Promise<EmailCheck> {
  const email = (raw ?? "").trim().toLowerCase();
  if (!SINTAXIS.test(email)) {
    return { verdict: "sintaxis", ok: false, reason: "no parece una dirección de correo" };
  }
  const domain = email.split("@")[1];

  if (DESECHABLES.has(domain)) {
    return { verdict: "desechable", ok: false, reason: "correo temporal" };
  }

  let tieneMx = mxCache.get(domain);
  if (tieneMx === undefined) {
    try {
      const mx = await dns.resolveMx(domain);
      // ⚠️ Un «null MX» (RFC 7505) es un registro con intercambiador `.` y prioridad 0:
      // significa EXPLÍCITAMENTE «este dominio no acepta correo». Contar registros lo daba
      // por bueno — `example.com` pasaba como válido. Medido con dig el 2026-08-22.
      tieneMx = mx.some((r) => r.exchange && r.exchange !== "." && r.exchange.trim() !== "");
    } catch (e) {
      const code = (e as { code?: string }).code;
      // ENOTFOUND = el dominio no existe. ENODATA = existe pero sin MX. Los dos significan
      // que no puede recibir correo, pero se distinguen porque «el dominio no existe» suele
      // ser una errata de captura y vale la pena revisarlo a mano.
      if (code === "ENOTFOUND" || code === "NXDOMAIN") {
        mxCache.set(domain, false);
        return { verdict: "sin_dominio", ok: false, reason: "el dominio no existe" };
      }
      tieneMx = false;
    }
    mxCache.set(domain, tieneMx);
  }

  if (!tieneMx) return { verdict: "sin_mx", ok: false, reason: "el dominio no recibe correo" };
  if (ROL.test(email.split("@")[0])) {
    return { verdict: "rol", ok: true, reason: "buzón automático: casi nunca contesta" };
  }
  return { verdict: "ok", ok: true, reason: "el dominio puede recibir correo" };
}

/** Cómo se ve el veredicto en una celda. Breve, porque va en una columna estrecha. */
export function verdictLabel(v: EmailVerdict): string {
  return {
    ok: "sirve",
    rol: "buzón de rol",
    sin_mx: "no recibe correo",
    sin_dominio: "dominio no existe",
    desechable: "temporal",
    sintaxis: "mal escrito",
  }[v];
}
