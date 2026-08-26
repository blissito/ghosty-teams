// Guard de salida para los conectores por CREDENCIALES (Odoo, Kommo y los que vengan).
//
// La diferencia con un conector OAuth es toda la razón de este archivo: en OAuth el host al
// que pegamos lo fija el registry (`api.calendly.com`), y lo teclea un programador. Aquí lo
// teclea el USUARIO, y la petición sale de NUESTRA red — la misma que ve el bridge del host
// de sandboxes en 172.20.0.1:8080. Sin este guard, cualquier miembro conecta "Odoo"
// apuntando ahí y usa las tools como proxy HTTP autenticado, CON la respuesta de vuelta al
// modelo. O sea SSRF con exfiltración.
//
// El criterio de fondo: la URL base es entrada NO CONFIABLE en cada uso, no configuración.
// Validarla sólo al guardar no alcanza — la fila vive años, el DNS cambia, y un dominio
// caducado lo recompra otro.
//
// Hermano de `forms/webhooks.server.ts`, de donde salen las tablas de rangos: ahí el mismo
// problema ya estaba resuelto para los webhooks de formularios. Lo que se añade sobre
// aquella versión es lo que la familia de conectores necesita y un webhook no: plantilla de
// host (Kommo es `{subdominio}.kommo.com`), allowlist por sufijo, rechazo de IP literal y de
// credenciales embebidas, allowlist de puertos, y caché de resolución.

import type { CredentialsDef } from "./registry";

// ── Rangos que nunca deben alcanzarse desde el proceso web ───────────────────────
// `172.16/12` es el que importa de verdad aquí: dentro cae 172.20.0.1, la API del host.
const PRIVATE_V4 = [
  /^0\./, // "esta" red
  /^10\./,
  /^127\./,
  /^169\.254\./, // link-local, incluye la metadata de AWS/GCP/Azure
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  /^192\.0\.0\./,
  /^192\.0\.2\./,
  /^198\.1[89]\./,
  /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./, // CGNAT
  /^(22[4-9]|23[0-9])\./, // multicast
  /^(24[0-9]|25[0-5])\./, // reservado + broadcast
];

const BLOCKED_SUFFIXES = [".local", ".internal", ".localdomain", ".home.arpa"];

// Sólo 443 en producción. Un puerto libre convierte esto en un escáner de puertos interno.
const PUBLIC_PORTS = new Set(["", "443"]);
// Los de Odoo self-hosted, únicamente cuando se permite http (dev).
const DEV_PORTS = new Set(["", "80", "443", "8069", "8071"]);

function allowHttp(): boolean {
  return process.env.CONNECTORS_ALLOW_HTTP === "1";
}

/** Sufijos permitidos por env — el cinturón operativo mientras el guard se asienta. */
function envAllowlist(): string[] {
  return (process.env.CONNECTORS_HOST_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function isPrivateAddress(ip: string, family: number): boolean {
  if (family === 6) {
    const v6 = ip.toLowerCase();
    if (v6 === "::" || v6 === "::1") return true;
    // fc00::/7 (únicas locales) y fe80::/10 (link-local).
    if (v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe8") || v6.startsWith("fe9")) return true;
    if (v6.startsWith("fea") || v6.startsWith("feb")) return true;
    // NAT64: 64:ff9b::/96 traduce a IPv4 y es un bypass real.
    if (v6.startsWith("64:ff9b:")) return true;
    // ::ffff:10.0.0.1 y compañía → se valida la v4 embebida.
    const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)/.exec(v6);
    if (mapped) return PRIVATE_V4.some((re) => re.test(mapped[1]));
    return false;
  }
  return PRIVATE_V4.some((re) => re.test(ip));
}

/** ¿El hostname es una IP literal (en cualquiera de sus grafías)? */
function isIpLiteral(host: string): boolean {
  if (host.startsWith("[")) return true; // [::1]
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return true;
  // `http://2130706433/` es 127.0.0.1 en decimal, y `0x7f000001` en hexadecimal. Un host
  // que sea sólo dígitos o sólo hex no es un nombre DNS válido de todos modos.
  if (/^\d+$/.test(host)) return true;
  if (/^0x[0-9a-f]+$/i.test(host)) return true;
  return false;
}

// Resolución cacheada 60s. El TTL corto es a propósito: es un compromiso entre no resolver
// en cada llamada y no quedarse pegado a un veredicto viejo.
const resolved = new Map<string, { at: number; error: string | null }>();
const RESOLVE_TTL_MS = 60_000;

async function checkDns(host: string): Promise<string | null> {
  const hit = resolved.get(host);
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.error;
  let error: string | null = null;
  try {
    const dns = await import("node:dns/promises");
    const addrs = await dns.lookup(host, { all: true });
    if (!addrs.length) error = "ese dominio no resuelve a ninguna dirección";
    // TODAS, no sólo la primera: un round-robin público/privado se colaría.
    for (const a of addrs) {
      if (isPrivateAddress(a.address, a.family)) {
        error = "esa dirección apunta a la red interna";
        break;
      }
    }
  } catch {
    error = "no se pudo resolver ese dominio";
  }
  resolved.set(host, { at: Date.now(), error });
  return error;
}

/**
 * Valida la URL/subdominio que tecleó el usuario y devuelve el **origin normalizado**
 * (`https://host`, sin path, query, hash ni credenciales).
 *
 * Lanza `Error` con un motivo en español si no pasa: ese texto se le enseña a la persona
 * en el formulario de conexión, así que dice qué corregir.
 */
export async function assertPublicOrigin(raw: string, def?: CredentialsDef, template?: string): Promise<string> {
  const value = String(raw ?? "").trim();
  if (!value) throw new Error("falta la dirección");

  // Kommo entrega un subdominio, no una URL: la plantilla lo convierte en origin.
  // Se toma la PRIMERA etiqueta DNS, no el host entero: la gente pega `acme.kommo.com` (o
  // la URL completa) en un campo que pide "acme", y concatenar sin más daba
  // `acme.kommo.com.kommo.com`, que no resuelve y deja un mensaje de error incomprensible.
  const candidate = template
    ? template.replace(
        "{value}",
        encodeURIComponent(
          value
            .replace(/^https?:\/\//i, "")
            .replace(/\/.*$/, "")
            .split(".")[0]
            .trim()
        )
      )
    : /^https?:\/\//i.test(value)
      ? value
      : `https://${value}`;

  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    throw new Error("esa dirección no es una URL válida");
  }

  // `https://user:pass@host` — el navegador y fetch los mandan como credenciales, y sirven
  // para disfrazar el host real ante una lectura rápida.
  if (u.username || u.password) throw new Error("la dirección no puede llevar usuario y contraseña");

  if (u.protocol !== "https:" && !(u.protocol === "http:" && allowHttp())) {
    throw new Error("tiene que ser https");
  }

  const ports = allowHttp() ? DEV_PORTS : PUBLIC_PORTS;
  if (!ports.has(u.port)) throw new Error(`ese puerto no está permitido (${u.port})`);

  const host = u.hostname.toLowerCase();

  // Una IP literal nunca es una instancia legítima de SaaS, y es la vía directa a la red
  // interna: se rechaza de entrada, en todas sus grafías.
  if (isIpLiteral(host)) throw new Error("hay que usar el nombre de dominio, no una dirección IP");
  if (host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new Error("no se puede apuntar a la red interna");
  }
  // Un nombre DNS de verdad: al menos un punto y un TLD alfabético.
  if (!/\.[a-z]{2,}$/.test(host)) throw new Error("esa dirección no parece un dominio público");

  // Allowlist declarativa del conector (Kommo: ["kommo.com"]) y la de operación por env.
  // Se aplican por separado: la del registry acota al proveedor, la del env acota el
  // despliegue. Si las dos existen, hay que pasar las dos.
  const suffixes = def?.allowHostSuffixes ?? [];
  if (suffixes.length && !suffixes.some((s) => host === s || host.endsWith(`.${s}`))) {
    throw new Error(`ese proveedor sólo admite direcciones de ${suffixes.join(", ")}`);
  }
  const envAllowed = envAllowlist();
  if (envAllowed.length && !envAllowed.some((s) => host === s || host.endsWith(`.${s}`))) {
    throw new Error("esa dirección no está autorizada en este despliegue");
  }

  const dnsError = await checkDns(host);
  if (dnsError) throw new Error(dnsError);

  return `${u.protocol}//${u.host}`;
}

/**
 * `fetch` para conectores de credenciales. Revalida el host **en cada llamada** (barato: la
 * resolución va cacheada 60s) porque el guard de arriba corrió el día que se conectó.
 *
 * ⚠️ `redirect: "manual"` no es opcional. Un host público que responde `302 →
 * http://172.20.0.1:8080` se salta TODA la validación de arriba, que se hizo sobre la URL
 * original; fetch seguiría el salto sin volver a preguntar.
 *
 * ⚠️ Lo que esto NO cierra: DNS rebinding. Entre nuestro lookup y el connect de fetch hay
 * un segundo lookup que no controlamos (TOCTOU). La solución real es pinnear el IP validado
 * con `undici.Agent({connect:{lookup}})`, que corre la validación en el instante del connect
 * y deja que el TLS siga viendo el hostname real. Ojo con el atajo que parece equivalente y
 * no lo es: `fetch("https://<ip>")` con header `Host` rompe SNI y la validación del
 * certificado. Mientras tanto, la allowlist por env es lo que sostiene esto.
 */
export async function guardedFetch(
  origin: string,
  path: string,
  init: RequestInit & { timeoutMs?: number; maxBytes?: number } = {}
): Promise<{ status: number; body: string }> {
  const { timeoutMs = 20_000, maxBytes = 2_000_000, ...rest } = init;
  const u = new URL(path, origin);
  const dnsError = await checkDns(u.hostname.toLowerCase());
  if (dnsError) throw new Error(dnsError);

  const res = await fetch(u, {
    ...rest,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });

  // Un 3xx desde el endpoint de una API es un error, no un camino a seguir.
  if (res.status >= 300 && res.status < 400) {
    throw new Error("esa dirección redirige a otro sitio; usa la URL definitiva de la instancia");
  }

  // La respuesta acaba en el contexto del modelo: se capa por coste y porque un host hostil
  // puede mandar un cuerpo infinito.
  const text = await res.text();
  return { status: res.status, body: text.length > maxBytes ? text.slice(0, maxBytes) : text };
}

/** Sólo para tests: olvida la caché de resolución. */
export function __resetDnsCache(): void {
  resolved.clear();
}
