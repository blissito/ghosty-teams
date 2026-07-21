// Multitenancy: resuelve el NAMESPACE sqld que sirve este request a partir del
// subdominio (acme.teams.ghosty.studio → workspace "acme" → namespace). El registro
// slug→namespace vive en el control-plane (ghosty.studio); lo consultamos firmado
// (GHOSTY_PARTNER_SECRET) y lo cacheamos por slug con TTL corto. TanStack Start ya
// mantiene contexto por-request (getRequestHeader) → resolvemos lazy dentro de dbq,
// sin middleware global.
import crypto from "node:crypto";

const IDP = process.env.GHOSTY_IDENTITY_URL ?? "https://www.ghosty.studio";
const ROOT = process.env.TEAMS_ROOT_DOMAIN ?? "teams.ghosty.studio";

// Fallback single-tenant: namespace fijo por env (dev local; o caja dedicada
// enterprise que sirve UN solo workspace).
function envNamespace(): string | null {
  return process.env.SQLD_NAMESPACE || process.env.EASYBITS_DB_ID || null;
}

const cache = new Map<string, { ns: string; exp: number }>();
const TTL_MS = 60_000;

// "acme" de acme.teams.ghosty.studio. Apex (teams / www) → null (sin tenant: es el
// selector de workspaces).
export function slugFromHost(host: string): string | null {
  const h = (host || "").split(":")[0].toLowerCase();
  if (!h || h === ROOT || h === `www.${ROOT}`) return null;
  if (h.endsWith(`.${ROOT}`)) return h.slice(0, -(ROOT.length + 1)).split(".")[0] || null;
  return null;
}

async function currentHost(): Promise<string> {
  try {
    const { getRequestHeader, getRequestHost } = await import("@tanstack/react-start/server");
    const o = getRequestHeader("x-ghosty-origin");
    if (o) {
      try {
        return new URL(o).host;
      } catch {
        /* origin malformado → sigue a los otros headers */
      }
    }
    return getRequestHeader("x-forwarded-host") || getRequestHost() || "";
  } catch {
    return "";
  }
}

async function resolveNamespace(slug: string): Promise<string> {
  const hit = cache.get(slug);
  if (hit && hit.exp > Date.now()) return hit.ns;
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto
    .createHmac("sha256", process.env.GHOSTY_PARTNER_SECRET!)
    .update(`${ts}.${slug}`)
    .digest("hex");
  const res = await fetch(
    `${IDP}/internal/workspaces/${encodeURIComponent(slug)}?ts=${ts}&sig=${sig}`
  );
  if (!res.ok) throw new Error(`workspace "${slug}" no resoluble (${res.status})`);
  const j = (await res.json()) as { namespace?: string; status?: string };
  if (!j.namespace) throw new Error(`workspace "${slug}" sin namespace`);
  cache.set(slug, { ns: j.namespace, exp: Date.now() + TTL_MS });
  return j.namespace;
}

/** Namespace sqld del tenant de este request (por subdominio; fallback a env). */
export async function currentNamespace(): Promise<string> {
  const slug = slugFromHost(await currentHost());
  if (!slug) {
    const env = envNamespace();
    if (env) return env;
    throw new Error(
      "sin tenant: host sin subdominio de workspace y sin SQLD_NAMESPACE/EASYBITS_DB_ID"
    );
  }
  return resolveNamespace(slug);
}

/** Invalida la cache de un slug (p.ej. tras re-provisionar). */
export function invalidateTenant(slug: string): void {
  cache.delete(slug);
}
