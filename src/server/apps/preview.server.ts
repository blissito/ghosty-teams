// Previews por PR: la URL donde una persona (y @check) VE el cambio antes de mezclarlo.
//
// Capa 1, sin configurar nada: si el repo ya publica previews (Vercel, Netlify, Cloudflare
// Pages, Render, Railway, review apps de Fly), su URL ya está en GitHub, en las deployments
// del commit (`environment_url`) o en los commit statuses. Aquí sólo se lee.
//
// Lo que NO es preview: el deployment a producción, y las URLs de tablero del proveedor
// (vercel.com/…, app.netlify.com/…): llevan a un panel con login, no a la app.
import { githubApi } from "../connectors/github.server";

export type PreviewState = "ready" | "pending" | "failed" | "none";
export type Preview = { state: PreviewState; url: string | null; provider: string | null; sha: string | null };

const NONE: Preview = { state: "none", url: null, provider: null, sha: null };

const PROVIDERS: [RegExp, string][] = [
  [/\.vercel\.app$/i, "Vercel"],
  [/\.netlify\.app$/i, "Netlify"],
  [/\.pages\.dev$/i, "Cloudflare Pages"],
  [/\.onrender\.com$/i, "Render"],
  [/\.up\.railway\.app$/i, "Railway"],
  [/\.fly\.dev$/i, "Fly"],
];

/** Hosts de paneles de proveedor: su URL no es la app. */
const DASHBOARDS = /^(vercel\.com|app\.netlify\.com|dash\.cloudflare\.com|dashboard\.render\.com|railway\.app|fly\.io|github\.com)$/i;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function providerOf(url: string, fallback?: string | null): string | null {
  const host = hostOf(url);
  if (host) for (const [re, name] of PROVIDERS) if (re.test(host)) return name;
  return fallback || null;
}

/** ¿Es una URL de app (no de panel) que se puede abrir? */
export function isAppUrl(url: unknown): url is string {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return false;
  const host = hostOf(url);
  return !!host && !DASHBOARDS.test(host);
}

/** Producción no es preview: la bandera de GitHub o el nombre del entorno. */
export function isProduction(d: { environment?: unknown; production_environment?: unknown }): boolean {
  if (d.production_environment === true) return true;
  return /^(prod|production|live|main|master)$/i.test(String(d.environment ?? ""));
}

const PENDING = new Set(["pending", "queued", "in_progress"]);
const FAILED = new Set(["failure", "error"]);

/** Contexts de commit status que publican previews (Netlify y compañía). */
const STATUS_CONTEXT = /netlify|deploy.?preview|preview|cloudflare|render|railway|fly/i;

// Lo listo no cambia para un mismo commit; lo pendiente se vuelve a mirar pronto.
const cache = new Map<string, { at: number; value: Preview }>();
const PENDING_TTL_MS = 45_000;

/** La preview de un commit de `repo`. Nunca lanza: sin GitHub, `none`. */
export async function commitPreview(sub: string, repo: string, sha: string): Promise<Preview> {
  const key = `${repo}@${sha}`;
  const hit = cache.get(key);
  if (hit && (hit.value.state === "ready" || Date.now() - hit.at < PENDING_TTL_MS)) return hit.value;
  const value = await lookup(sub, repo, sha).catch(() => ({ ...NONE, sha }));
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function lookup(sub: string, repo: string, sha: string): Promise<Preview> {
  let pending: Preview | null = null;
  let failed: Preview | null = null;

  const deployments = await githubApi(sub, `/repos/${repo}/deployments?sha=${sha}&per_page=10`);
  if (Array.isArray(deployments)) {
    for (const d of deployments.filter((x: any) => !isProduction(x))) {
      const statuses = await githubApi(sub, `/repos/${repo}/deployments/${d.id}/statuses?per_page=1`);
      const s = Array.isArray(statuses) ? statuses[0] : null;
      if (!s) {
        pending ??= { state: "pending", url: null, provider: providerName(d), sha };
        continue;
      }
      const url = [s.environment_url, s.target_url].find(isAppUrl) ?? null;
      const state = String(s.state ?? "");
      if (state === "success" && url) return { state: "ready", url, provider: providerOf(url, providerName(d)), sha };
      if (PENDING.has(state)) pending ??= { state: "pending", url: null, provider: providerName(d), sha };
      else if (FAILED.has(state)) failed ??= { state: "failed", url: null, provider: providerName(d), sha };
    }
  }

  // Netlify (y otros) sólo dejan un commit status con la URL de la preview.
  const statuses = await githubApi(sub, `/repos/${repo}/commits/${sha}/statuses?per_page=50`);
  if (Array.isArray(statuses)) {
    const seen = new Set<string>();
    for (const s of statuses) {
      const ctx = String(s?.context ?? "");
      if (!STATUS_CONTEXT.test(ctx) || seen.has(ctx)) continue;
      seen.add(ctx); // vienen del más nuevo al más viejo: sólo cuenta el último de cada context
      const state = String(s.state ?? "");
      if (state === "success" && isAppUrl(s.target_url)) return { state: "ready", url: s.target_url, provider: providerOf(s.target_url, ctx), sha };
      if (state === "pending") pending ??= { state: "pending", url: null, provider: ctx, sha };
      else if (FAILED.has(state)) failed ??= { state: "failed", url: null, provider: ctx, sha };
    }
  }
  return pending ?? failed ?? { ...NONE, sha };
}

function providerName(d: any): string | null {
  const login = String(d?.creator?.login ?? "").replace(/\[bot\]$/, "");
  const known: Record<string, string> = { vercel: "Vercel", netlify: "Netlify", "cloudflare-workers-and-pages": "Cloudflare Pages", render: "Render", railway: "Railway" };
  return known[login.toLowerCase()] ?? (d?.environment ? String(d.environment) : null);
}

/** La preview de la cabeza de un PR. */
export async function prPreview(sub: string, prUrl: string): Promise<Preview> {
  const { parsePrUrl } = await import("./factory-runs.server");
  const pr = parsePrUrl(prUrl);
  if (!pr) return NONE;
  const r = await githubApi(sub, `/repos/${pr.repo}/pulls/${pr.number}`).catch(() => null);
  const sha = typeof r?.head?.sha === "string" ? r.head.sha : null;
  return sha ? commitPreview(sub, pr.repo, sha) : NONE;
}

/**
 * ¿El repo publica previews? Para «Listo para agentes»: alguna deployment reciente que no
 * sea de producción, o un commit status de preview en la cabeza de la rama principal.
 */
export async function repoHasPreviews(sub: string, repo: string, defaultBranch: string): Promise<boolean> {
  const deployments = await githubApi(sub, `/repos/${repo}/deployments?per_page=30`).catch(() => null);
  if (Array.isArray(deployments) && deployments.some((d: any) => !isProduction(d))) return true;
  const statuses = await githubApi(sub, `/repos/${repo}/commits/${encodeURIComponent(defaultBranch)}/statuses?per_page=30`).catch(() => null);
  return Array.isArray(statuses) && statuses.some((s: any) => STATUS_CONTEXT.test(String(s?.context ?? "")) && isAppUrl(s?.target_url));
}
