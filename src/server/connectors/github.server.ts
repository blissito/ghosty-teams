// Conector GitHub per-user. Calca el molde de denik.server.ts / sentry.server.ts.
//
// Es una GitHub APP en flujo user-to-server: el token actúa EN NOMBRE del
// usuario y sólo alcanza los repos que él eligió al instalar. Por eso todo lo
// que el agente escriba aparece con su nombre y respeta sus permisos — si no
// puede empujar a `main`, el agente tampoco.
//
// El token NUNCA sale de Teams: la caja del agente sólo tiene un tool-token HMAC
// de 15 min con su `sub` firmado, y los handlers de aquí corren en el servidor.
import { getValidToken } from "./oauth.server";
import { getConnectorRow } from "./store.server";
import { notaNombres, type ConnectorTool, type ToolChannel } from "./impl";
import type { ToolDest } from "./tool-token.server";
import { listRoomRepos } from "../../db.server";
import {
  appJwtOrNull,
  botIdentityEnabled,
  coAuthorTrailer,
  installationToken,
  pushDenialReason,
  agentTrailer,
} from "./github-app.server";
import { loadChecks, type PrSnapshot } from "./github-checks";

const API = "https://api.github.com";
const APP_SLUG = process.env.GITHUB_APP_SLUG ?? "ghosty-studio";
/** Instalar la app / agregar repos. La misma liga sirve para las dos cosas. */
const INSTALL_URL = `https://github.com/apps/${APP_SLUG}/installations/new`;
/** Cambiar los repos de una instalación que ya existe. */
const MANAGE_URL = "https://github.com/settings/installations";

type GithubMeta = { login?: string | null; name?: string | null; avatarUrl?: string | null };

async function readMeta(sub: string): Promise<GithubMeta | null> {
  const row = await getConnectorRow(sub, "github");
  if (!row?.access_token || !row.meta) return null;
  try {
    return JSON.parse(row.meta) as GithubMeta;
  } catch {
    return null;
  }
}

/**
 * Llamada a la API de GitHub con el token del usuario.
 *
 * Los errores se traducen a español accionable en vez de propagar el status:
 * lo que devuelve esta función se lo lee el MODELO, y "404" lo lleva a decir
 * que el repo no existe cuando casi siempre significa "no lo incluiste al
 * instalar la app".
 */
/** Para la Software Factory (CI starter, proteger main): el mismo cliente, con el token de `sub`. */
/**
 * 👀 del bot sobre un comentario de GitHub: «lo recibí». Como Copilot/CodeRabbit: sin esto la
 * persona comentaba @ghosty y en GitHub no se notaba nada (MailMask, 4-oct). Nunca lanza.
 */
export async function ackGithubComment(repo: string, commentUrl: string): Promise<boolean> {
  const issue = /#issuecomment-(\d+)/.exec(commentUrl)?.[1];
  const review = /#discussion_r(\d+)/.exec(commentUrl)?.[1];
  if (!issue && !review) return false;
  try {
    const instId = await installationIdFor(repo);
    const token = instId ? await installationToken(instId) : null;
    if (!token) return false;
    const path = issue ? `/repos/${repo}/issues/comments/${issue}/reactions` : `/repos/${repo}/pulls/comments/${review}/reactions`;
    const r = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify({ content: "eyes" }),
      signal: AbortSignal.timeout(8000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// Cuándo se libera el límite de GitHub, por cuenta (epoch s). Lo lee factory_check_verdict para
// programar la nueva revisión; sin dato, la fábrica espera 15 min.
const rateLimitReset = new Map<string, number>();

/** La hora de reset: `x-ratelimit-reset` (epoch s) o `retry-after` (s); si no, 15 min. */
export function rateLimitResetFrom(h: Headers, now = Math.floor(Date.now() / 1000)): number {
  const reset = Number(h.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > now) return reset;
  const after = Number(h.get("retry-after"));
  if (Number.isFinite(after) && after > 0) return now + after;
  return now + 15 * 60;
}

function noteRateLimit(sub: string, resetAt: number): void {
  rateLimitReset.set(sub, resetAt);
  rateLimitReset.set("*", Math.max(rateLimitReset.get("*") ?? 0, resetAt));
}

/** El reset pendiente del límite de GitHub para esa cuenta (o el último de cualquiera), o null. */
export function githubRateLimitResetAt(sub?: string | null): number | null {
  const now = Math.floor(Date.now() / 1000);
  const r = (sub ? rateLimitReset.get(sub) : undefined) ?? rateLimitReset.get("*");
  return r && r > now ? r : null;
}

export function githubApi(sub: string, path: string, init?: RequestInit): Promise<any> {
  return api(sub, path, init);
}

async function api(sub: string, path: string, init?: RequestInit): Promise<any> {
  const token = await getValidToken(sub, "github");
  if (!token) {
    return { error: "La cuenta de GitHub no está conectada. Conéctala en Ajustes → Integraciones." };
  }
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (e) {
    return { error: `No pude contactar a GitHub: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (res.ok) return res.status === 204 ? { ok: true } : await res.json().catch(() => ({}));

  const body = (await res.text().catch(() => "")).slice(0, 400);
  if (res.status === 401) {
    return { error: "La sesión de GitHub expiró. Pídele que reconecte GitHub en Ajustes → Integraciones." };
  }
  // Rate limit: primario (403 con remaining=0), secundario (403/429 con «secondary rate limit» o
  // retry-after) o 429. Se anota cuándo se libera: la fábrica pausa al pedido hasta esa hora (#137).
  if (
    res.status === 429 ||
    (res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || !!res.headers.get("retry-after") || /secondary rate limit|rate limit exceeded/i.test(body)))
  ) {
    const resetAt = rateLimitResetFrom(res.headers);
    noteRateLimit(sub, resetAt);
    const at = new Date(resetAt * 1000).toISOString().slice(11, 16);
    return { error: `GitHub está limitando las peticiones. Se libera hacia las ${at} UTC; espera unos minutos.`, rateLimitResetAt: resetAt };
  }
  if (res.status === 403) {
    // Función de plan, no de permiso: rulesets y protección de ramas en repos PRIVADOS de
    // cuentas gratis. Se deja el texto de GitHub para que quien lo lea sepa qué pide.
    if (/upgrade to github pro|make this repository public/i.test(body)) {
      return { error: "Límite de GitHub, no de Ghosty: en repos privados de cuentas gratis, GitHub pide Pro o Team para esto (Upgrade to GitHub Pro or make this repository public)." };
    }
    return {
      error:
        "Sin permiso para eso en GitHub. La app se instaló con un conjunto de permisos fijo; " +
        "si hace falta uno nuevo hay que actualizarlo del lado nuestro, no reconectando.",
    };
  }
  if (res.status === 404) {
    // El 404 de GitHub es deliberadamente ambiguo (no confirma repos privados),
    // así que la causa más probable NO es que no exista.
    return {
      error:
        "GitHub SÍ está conectado, pero no encuentro eso. Lo más probable es que ese repositorio no " +
        `esté entre los que se eligieron al instalar. Se agregan aquí: ${INSTALL_URL} — ` +
        "dale ese enlace al usuario. También puede ser un nombre mal escrito.",
      installUrl: INSTALL_URL,
    };
  }
  if (res.status === 409) return { error: "Conflicto en GitHub (¿la rama ya existe o el archivo cambió?)." };
  if (res.status === 422) return { error: `GitHub rechazó los datos: ${body}` };
  return { error: `GitHub respondió ${res.status}: ${body}` };
}

/**
 * Igual que `api`, pero para endpoints que devuelven TEXTO PLANO en vez de JSON.
 *
 * Hoy sólo lo usa el log de un job de Actions, que responde un 302 hacia una URL
 * firmada de blob storage. `fetch` sigue el redirect solo y —por spec— **deja
 * caer el header Authorization al cambiar de origen**, que es justo lo que hace
 * falta: mandárselo al blob lo haría fallar.
 */
async function apiText(sub: string, path: string): Promise<string | { error: string }> {
  const token = await getValidToken(sub, "github");
  if (!token) {
    return { error: "La cuenta de GitHub no está conectada. Conéctala en Ajustes → Integraciones." };
  }
  try {
    const res = await fetch(`${API}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) return { error: `GitHub respondió ${res.status} al pedir el log.` };
    return await res.text();
  } catch (e) {
    return { error: `No pude bajar el log: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * El log de un job de CI son megabytes con una marca de tiempo por línea. Lo que
 * sirve para diagnosticar es el FINAL (donde revienta) más las líneas que se ven
 * como error, así que se manda eso y no el volcado entero — que además reventaría
 * el contexto del modelo.
 */
function trimLog(raw: string): { errorLines: string[]; tail: string; totalLines: number } {
  const lines = raw.split("\n");
  // GitHub prefija cada línea con un ISO-8601. Estorba para leer y para buscar.
  const clean = lines.map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, ""));
  const RE = /(^|\s)(error|failed|failure|fatal|exception|assertion|✗|✖|not ok)\b|error TS\d+|npm ERR!/i;
  const errorLines = clean.filter((l) => RE.test(l) && l.trim()).slice(-40);
  return {
    errorLines,
    tail: clean.slice(-120).join("\n").slice(-8000),
    totalLines: clean.length,
  };
}

// ── Escritura con la identidad de BOT ────────────────────────────────────────
//
// Sólo las tres operaciones que CREAN el pull request (rama, commit, PR) pasan por aquí.
// Reviews y comentarios se quedan como el usuario a propósito: una aprobación tiene que
// ser atribuible a una persona, y todo el objetivo del cambio es que un humano apruebe.
// Las lecturas también, porque respetan su acceso real y el cupo de peticiones es por
// usuario en vez de un único cubo compartido por los diez.
//
// Con la identidad apagada (sin las env de la App) esto devuelve el token del usuario y
// el comportamiento es idéntico al de siempre.

const instCache = new Map<string, number>();

/** Id de instalación que cubre un repo. Se pregunta con el JWT de la App, no con un token. */
async function installationIdFor(repoPath: string): Promise<number | null> {
  if (!botIdentityEnabled()) return null;
  const hit = instCache.get(repoPath);
  if (hit) return hit;
  const r = await appFetch(`/repos/${repoPath}/installation`);
  const id = typeof r?.id === "number" ? r.id : null;
  if (id) instCache.set(repoPath, id);
  return id;
}

/**
 * Resuelve con qué token se escribe, y **re-impone el permiso del solicitante**.
 *
 * ⚠️ Este chequeo no es opcional. Un installation token tiene el techo de la App, no la
 * intersección App∩usuario, así que sin él alguien con acceso de sólo lectura podría
 * hacer que el bot empujara por él. Es la única barrera que reemplaza a la que GitHub
 * aplicaba sola cuando escribíamos como la persona.
 */
async function writeToken(
  sub: string,
  repoPath: string,
): Promise<{ token: string; bot: boolean } | { error: string }> {
  const userToken = await getValidToken(sub, "github");
  if (!userToken) return { error: "La cuenta de GitHub no está conectada. Conéctala en Ajustes → Integraciones." };
  if (!botIdentityEnabled()) return { token: userToken, bot: false };

  const meta = await readMeta(sub);
  const login = meta?.login ?? "";
  if (!login) return { token: userToken, bot: false };

  const denial = await pushDenialReason(userToken, repoPath, login);
  if (denial) return { error: denial };

  const instId = await installationIdFor(repoPath);
  const botToken = instId ? await installationToken(instId) : null;
  // Sin bot disponible se sigue como el usuario: preferimos un PR que sí se abre —con la
  // limitación de que no podrá autoaprobarlo— a un fallo por una App mal configurada.
  return botToken ? { token: botToken, bot: true } : { token: userToken, bot: false };
}

/** Trailer de co-autoría de la persona dueña de `sub` (el mismo que pone `github_push_files`). */
export async function coAuthorOf(sub: string): Promise<string> {
  const login = (await readMeta(sub))?.login;
  return login ? coAuthorTrailer(login).trim() : "";
}

/**
 * Token con el que el proxy git de la fábrica (`apps/factory-git.server.ts`) empuja por la caja.
 * Es `writeToken` tal cual: re-impone el permiso de quien pidió. Nunca sale de Teams.
 */
export function gitWriteToken(sub: string, repoPath: string): Promise<{ token: string; bot: boolean } | { error: string }> {
  return writeToken(sub, repoPath);
}

/**
 * Liga directa a la página donde el dueño ACEPTA los permisos nuevos de la App en su
 * instalación («Review request»). Cuenta personal → /settings/installations/<id>;
 * organización → /organizations/<org>/settings/installations/<id>. Sin App o sin
 * instalación, la lista general.
 */
async function permissionsReviewUrl(repoPath: string): Promise<string> {
  const r = await appFetch(`/repos/${repoPath}/installation`).catch(() => null);
  const id = typeof r?.id === "number" ? r.id : null;
  if (!id) return "https://github.com/settings/installations";
  const org = String(r?.account?.type ?? "") === "Organization" ? String(r?.account?.login ?? "") : "";
  // `/permissions/update` cae directo en «Accept new permissions» (sin buscar el botón).
  return org
    ? `https://github.com/organizations/${org}/settings/installations/${id}/permissions/update`
    : `https://github.com/settings/installations/${id}/permissions/update`;
}

/** Error de permiso faltante con la liga para aceptarlo (el agente la pasa tal cual). */
async function missingPermission(repoPath: string, permission: string): Promise<{ error: string }> {
  const url = await permissionsReviewUrl(repoPath);
  return {
    error: `A la GitHub App de Ghosty le falta el permiso «${permission}» en este repo. El dueño lo acepta aquí (botón «Accept new permissions»): ${url} — pásale la liga tal cual.`,
  };
}

/** Lo que las automatizaciones necesitan saber de un PR que el evento no trae completo. */
export type AppPrInfo = {
  state: string;
  draft: boolean;
  author: string | null;
  authorType: string | null;
  head: string | null;
  headSha: string | null;
  headRepo: string | null;
  base: string | null;
  mergeableState: string | null;
  url: string | null;
};

/**
 * Un PR leído con el token de INSTALACIÓN de la App (sin persona detrás): lo usan las
 * automatizaciones de `automations/`, que corren por un webhook. `null` si la App no está
 * en el repo o GitHub falla. Nunca lanza.
 */
export async function appPullRequest(repo: string, number: number): Promise<AppPrInfo | null> {
  try {
    const instId = await installationIdFor(repo);
    const token = instId ? await installationToken(instId) : null;
    if (!token) return null;
    const res = await fetch(`${API}/repos/${repo}/pulls/${Number(number)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const p: any = await res.json();
    return {
      state: String(p?.state ?? ""),
      draft: !!p?.draft,
      author: p?.user?.login ?? null,
      authorType: p?.user?.type ?? null,
      head: p?.head?.ref ?? null,
      headSha: p?.head?.sha ?? null,
      headRepo: p?.head?.repo?.full_name ?? null,
      base: p?.base?.ref ?? null,
      mergeableState: p?.mergeable_state ?? null,
      url: p?.html_url ?? null,
    };
  } catch {
    return null;
  }
}

/** GET a la API con el JWT de la App (sin instalación). Devuelve `null` si falla. */
async function appFetch(path: string): Promise<any> {
  const jwt = appJwtOrNull();
  if (!jwt) return null;
  try {
    const res = await fetch(`${API}${path}`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/**
 * URL firmada de codeload para el tarball de un repo.
 *
 * GitHub responde 302, y un `fetch` normal seguiría el redirect bajando el archivo
 * completo al proceso de Teams. Aquí lo que se quiere es la URL misma —efímera, de un
 * solo archivo y sin credencial— para dársela a la caja del agente, así que el
 * redirect se lee a mano. La credencial nunca viaja: codeload no la necesita.
 */
async function tarballUrl(token: string, p: string, ref: string): Promise<string | { error: string }> {
  try {
    const res = await fetch(`${API}/repos/${p}/tarball/${encodeURIComponent(ref)}`, {
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    const loc = res.headers.get("location");
    if (loc && res.status >= 300 && res.status < 400) return loc;
    return { error: `GitHub respondió ${res.status} al pedir el tarball.` };
  } catch (e) {
    return { error: `No pude contactar a GitHub: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Registra la preview de un commit en GitHub como Deployment de entorno `preview` (transitorio):
 * el PR enseña «This branch was successfully deployed · View deployment» y el botón queda en el commit.
 * Antes la liga sólo vivía en el hilo de Ghosty y el PR no sabía que había preview (bliss, 15-oct).
 * Va como el bot si la App tiene permiso de deployments; si no, como el usuario.
 */
export async function publishPreviewDeployment(sub: string, repo: string, sha: string, url: string): Promise<{ ok: true } | { error: string }> {
  const auth = await writeToken(sub, repo);
  if ("error" in auth) return auth;
  const userToken = auth.bot ? await getValidToken(sub, "github") : null;
  const tokens = [auth.token, ...(userToken ? [userToken] : [])];
  let last = "sin token";
  for (const token of tokens) {
    const dep = await apiWith(token, `/repos/${repo}/deployments`, {
      method: "POST",
      body: JSON.stringify({
        ref: sha,
        environment: "preview",
        transient_environment: true,
        production_environment: false,
        required_contexts: [],
        auto_merge: false,
        description: "Preview de Ghosty",
      }),
    });
    if (dep?.error || !dep?.id) {
      last = dep?.error ?? "sin id";
      continue;
    }
    const st = await apiWith(token, `/repos/${repo}/deployments/${dep.id}/statuses`, {
      method: "POST",
      body: JSON.stringify({ state: "success", environment_url: url, log_url: url, auto_inactive: true, description: "Preview lista" }),
    });
    if (st?.error) return { error: st.error };
    return { ok: true };
  }
  return { error: last };
}

// ── Check runs de la App («Ghosty · Preview») ────────────────────────────────
// La Checks API sólo la escribe una GitHub App: va siempre con el token de instalación, sin
// respaldo del usuario. (repo@sha:nombre) → el check que ya publicamos y con qué contenido.
const checkRuns = new Map<string, { id: number; completed: boolean; sig: string | null }>();

/** ¿La instalación de la App en el repo puede escribir checks? Sin eso un check requerido nunca reporta. */
export async function appCanWriteChecks(repo: string): Promise<boolean> {
  const instId = await installationIdFor(repo);
  if (!instId) return false;
  const inst = await appFetch(`/app/installations/${instId}`);
  return inst?.permissions?.checks === "write";
}

/**
 * Crea o actualiza el check `name` en `sha`, idempotente por (repo, sha): con el mismo contenido
 * no llama a GitHub; si no lo recuerda, lo busca por nombre (de NUESTRA App) antes de crear otro.
 */
export async function upsertCheckRun(
  repo: string,
  sha: string,
  c: { name: string; status: "in_progress" | "completed"; conclusion: string | null; title: string; summary: string; detailsUrl?: string | null },
): Promise<{ ok: true; action: "skip" | "patch" | "post" } | { error: string }> {
  const { checkRunWrite } = await import("../apps/factory-preview-check");
  const key = `${repo.toLowerCase()}@${sha}:${c.name}`;
  const sig = JSON.stringify([c.status, c.conclusion, c.title, c.summary, c.detailsUrl ?? null]);
  let existing = checkRuns.get(key) ?? null;
  if (existing?.sig === sig) return { ok: true, action: "skip" };
  // El mismo token de instalación que `publishPreviewDeployment` (vía `writeToken`), sin usuario.
  const instId = await installationIdFor(repo);
  const token = instId ? await installationToken(instId) : null;
  if (!token) return { error: "la GitHub App no está instalada en el repo (o no está configurada)" };
  if (!existing) {
    const appId = Number(process.env.GITHUB_APP_ID ?? 0);
    const list = await apiWith(token, `/repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(c.name)}&filter=latest&per_page=20`);
    const own = Array.isArray(list?.check_runs) ? list.check_runs.find((r: any) => !appId || Number(r?.app?.id) === appId) : null;
    if (own?.id) existing = { id: Number(own.id), completed: own.status === "completed", sig: null };
  }
  const action = checkRunWrite(existing, { status: c.status, sig });
  const body: Record<string, unknown> = {
    name: c.name,
    status: c.status,
    output: { title: c.title.slice(0, 250), summary: c.summary.slice(0, 60000) },
    ...(c.detailsUrl ? { details_url: c.detailsUrl } : {}),
    ...(c.status === "completed" ? { conclusion: c.conclusion ?? "neutral", completed_at: new Date().toISOString() } : {}),
  };
  const r =
    action === "patch" && existing
      ? await apiWith(token, `/repos/${repo}/check-runs/${existing.id}`, { method: "PATCH", body: JSON.stringify(body) })
      : await apiWith(token, `/repos/${repo}/check-runs`, {
          method: "POST",
          body: JSON.stringify({ ...body, head_sha: sha, started_at: new Date().toISOString() }),
        });
  if (r?.error || !r?.id) return { error: String(r?.error ?? "GitHub no devolvió el check") };
  if (checkRuns.size > 2000) checkRuns.clear();
  checkRuns.set(key, { id: Number(r.id), completed: c.status === "completed", sig });
  return { ok: true, action };
}

/** Igual que `api`, pero con un token ya resuelto (el del bot o el del usuario). */
async function apiWith(token: string, path: string, init?: RequestInit): Promise<any> {
  try {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init?.body ? { "content-type": "application/json" } : {}),
      },
    });
    if (res.ok) return res.status === 204 ? { ok: true } : await res.json().catch(() => ({}));
    const body = (await res.text().catch(() => "")).slice(0, 400);
    return { error: `GitHub respondió ${res.status}: ${body}` };
  } catch (e) {
    return { error: `No pude contactar a GitHub: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * GraphQL con el token del usuario. Hace falta para lo que REST no tiene: sacar un PR de
 * borrador y encender el auto-merge.
 *
 * ⚠️ GraphQL contesta 200 aunque falle: el error viene en `errors[]`. Por eso se revisan
 * los dos, o un rechazo pasaría por éxito.
 */
async function graphql(sub: string, query: string, variables: Record<string, unknown>): Promise<any> {
  const token = await getValidToken(sub, "github");
  if (!token) {
    return { error: "La cuenta de GitHub no está conectada. Conéctala en Ajustes → Integraciones." };
  }
  try {
    const res = await fetch(`${API}/graphql`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || j?.errors?.length) {
      const msg = j?.errors?.map((e: any) => e?.message).filter(Boolean).join("; ") || `GitHub respondió ${res.status}`;
      return { error: msg };
    }
    return j?.data ?? {};
  } catch (e) {
    return { error: `No pude contactar a GitHub: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Lo que la vigilancia de un PR necesita saber en cada vuelta: si sigue abierto, su HEAD,
 * cómo va CI y si tiene auto-merge. `repo` va como "dueño/repo" (sin escapar).
 */
// ── Ramas de los evals de la fábrica (apps/factory-evals.ts) ──────────────────
// La plataforma crea la rama del eval en el commit base del PR original y la borra al
// calificar. Sólo toca ramas `ghosty-eval/`: nunca una rama de trabajo de nadie.

const EVAL_REF = /^ghosty-eval\/\d+$/;

export async function createEvalBranch(sub: string, repo: string, branch: string, sha: string): Promise<{ ok: true } | { error: string }> {
  if (!EVAL_REF.test(branch)) return { error: "sólo ramas ghosty-eval/<n>" };
  const w = await writeToken(sub, repo);
  if ("error" in w) return w;
  const r = await apiWith(w.token, `/repos/${repo}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }) });
  return r?.error ? { error: String(r.error) } : { ok: true };
}

export async function deleteEvalBranch(sub: string, repo: string, branch: string): Promise<boolean> {
  if (!EVAL_REF.test(branch)) return false;
  const w = await writeToken(sub, repo);
  if ("error" in w) return false;
  const r = await apiWith(w.token, `/repos/${repo}/git/refs/heads/${branch}`, { method: "DELETE" });
  return !r?.error;
}

/** Diff legible (archivo + patch) de una lista de archivos de GitHub, recortado a `max`. */
function patchText(files: any[], max: number): string {
  let out = "";
  for (const f of files) {
    const chunk = `--- ${f?.filename} (+${f?.additions ?? 0} −${f?.deletions ?? 0})\n${f?.patch ?? "(sin patch: binario o muy grande)"}\n\n`;
    if (out.length + chunk.length > max) return out + `… (diff recortado a ${max} caracteres; lee el resto con github_read_file)`;
    out += chunk;
  }
  return out || "(sin cambios)";
}

/** Diff de `base...head` (la rama de un eval contra su commit base). */
export async function compareDiff(sub: string, repo: string, base: string, head: string, max = 30000): Promise<string | null> {
  const r = await api(sub, `/repos/${repo}/compare/${base}...${encodeURIComponent(head)}`);
  return Array.isArray(r?.files) ? patchText(r.files, max) : null;
}

/** Diff de un PR (el original, para compararlo con el eval). */
export async function prDiff(sub: string, repo: string, number: number, max = 30000): Promise<string | null> {
  const r = await api(sub, `/repos/${repo}/pulls/${number}/files?per_page=100`);
  return Array.isArray(r) ? patchText(r, max) : null;
}

export async function prSnapshot(sub: string, repo: string, number: number): Promise<PrSnapshot | { error: string }> {
  const p = repoPath(repo);
  if (!p) return BAD_REPO;
  const pr = await api(sub, `/repos/${p}/pulls/${number}`);
  if (pr?.error) return pr;
  const sha = String(pr?.head?.sha ?? "");
  const checks = await loadChecks((path) => api(sub, path), p, sha);
  if ("error" in checks) return checks;
  return {
    merged: pr?.merged === true || pr?.merged_at != null,
    state: pr?.state === "closed" ? "closed" : "open",
    sha,
    checks,
    autoMerge: pr?.auto_merge != null,
  };
}

const qs = (args: Record<string, unknown>, keys: string[]): string => {
  const p = new URLSearchParams();
  for (const k of keys) {
    const v = args[k];
    if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
};

/** "owner/repo" → path seguro. Acepta también la URL completa, que es lo que se pega. */
function repoPath(repo: unknown): string | null {
  const s = String(repo ?? "").trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
  const m = s.match(/^([^/\s]+)\/([^/\s]+)/);
  return m ? `${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}` : null;
}

const BAD_REPO = { error: 'Falta el repositorio, o está mal escrito. Va como "dueño/repo".' };

/**
 * "owner/repo" canónico para GUARDAR y COMPARAR — sin percent-encoding, que es lo que
 * `repoPath` hace para meterlo en una URL. Son dos cosas distintas y confundirlas haría que
 * un repo con caracteres escapables nunca casara con su propia fila.
 */
export function normalizeRepo(repo: unknown): string | null {
  const s = String(repo ?? "").trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
  const m = s.match(/^([^/\s]+)\/([^/\s]+)/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Repos atados a un room. Lista vacía = el room no declaró ninguno. */
async function roomRepos(channelId: number) {
  try {
    return await listRoomRepos(channelId);
  } catch {
    // Un fallo de DB no puede ABRIR la frontera. Se trata como "sin repos".
    return [];
  }
}

/**
 * ¿A qué repos alcanza este turno? `null` = sin restricción. Array = exactamente esos, y
 * vacío significa NINGUNO.
 *
 * Las tres situaciones, que antes eran una sola por accidente:
 *
 * - **Room** → los repos conectados a ese room. Es la frontera de siempre.
 * - **DM 1:1** → sin restricción, a propósito: el único humano es el dueño del token y lee
 *   sus propios repos. Acotarlo sería quitarle al usuario acceso a lo que ya es suyo.
 * - **DM de grupo** → como un room sin repos. Aquí el agente lee con el token de QUIEN
 *   ESCRIBIÓ y lo vuelca a los demás, que en GitHub pueden no tener ese acceso: es
 *   exactamente el daño que motivó atar repos a los rooms. Se cierra reusando la maquinaria
 *   que ya existe —incluido su mensaje explicativo— en vez de inventar una rama nueva.
 */
export async function allowedRepos(dest: ToolDest | null): Promise<string[] | null> {
  if (dest?.channelId) return (await roomRepos(dest.channelId)).map((r) => r.repo);
  if (dest?.dmId) {
    // El `catch` es el mismo cinturón que lleva `roomRepos`: si no se puede saber qué clase
    // de DM es, se trata como grupo. Un fallo de DB puede cerrar la frontera, nunca abrirla.
    const esGrupo = await import("../../db.server")
      .then((db) => db.isGroupDm(dest.dmId!))
      .catch(() => true);
    return esGrupo ? [] : null;
  }
  return null;
}

/**
 * Tools que NO llevan repo en los argumentos, así que el candado no puede exigírselo.
 * ⚠️ Se enumeran a mano: dar por hecho que todas llevan `repo` dejaría a estas dos
 * rechazadas para siempre.
 */
// `github_create_repo`: crear no lee nada de nadie; el repo nuevo es de quien lo pide.
export const REPOLESS_TOOLS = new Set([
  "github_list_repos",
  "github_install_link",
  "github_create_repo",
  "github_get_me",
  "github_search_users",
  "github_search_repos",
  "github_list_gists",
  "github_get_gist",
  "github_create_gist",
]);

/**
 * Sin repo y con datos privados de la persona (repos privados en una búsqueda, gists secretos):
 * en un room los leería con SU token y los verían todos. Sólo donde no hay frontera de repos
 * (DM 1:1); en un room ni se ofrecen ni corren.
 */
export const PERSONAL_ONLY_TOOLS = new Set(["github_search_repos", "github_list_gists", "github_get_gist", "github_create_gist"]);

// ── Poda ─────────────────────────────────────────────────────────────────────
// Un issue o un PR de la API traen ~80 campos, casi todos URLs de la propia API
// que al modelo no le sirven de nada y que multiplican por diez lo que entra al
// contexto del turno.

const trimIssue = (i: any) => ({
  number: i?.number,
  title: i?.title,
  state: i?.state,
  author: i?.user?.login ?? null,
  labels: (i?.labels ?? []).map((l: any) => (typeof l === "string" ? l : l?.name)),
  assignees: (i?.assignees ?? []).map((a: any) => a?.login),
  comments: i?.comments,
  createdAt: i?.created_at,
  updatedAt: i?.updated_at,
  url: i?.html_url,
  isPullRequest: !!i?.pull_request,
  body: typeof i?.body === "string" ? i.body.slice(0, 4000) : null,
});

const trimPr = (p: any) => ({
  ...trimIssue(p),
  draft: p?.draft,
  merged: p?.merged ?? p?.merged_at != null,
  mergeable: p?.mergeable,
  head: p?.head?.ref,
  // El SHA de la cabeza: la Software Factory lo compara antes y después de que @check revise
  // para saber que no empujó nada (`apps/factory-runs.server.ts`).
  headSha: p?.head?.sha,
  // De dónde sale la rama: si no es el mismo repo es un fork y la App no le puede empujar.
  headRepo: p?.head?.repo?.full_name ?? null,
  base: p?.base?.ref,
  // "clean" | "dirty" (conflictos) | "behind" | "blocked" | "unstable" | "unknown" (GitHub lo calcula tarde).
  mergeableState: p?.mergeable_state,
  changedFiles: p?.changed_files,
  additions: p?.additions,
  deletions: p?.deletions,
});

// ── Contexto ambiente ────────────────────────────────────────────────────────

export async function ambientContext(
  sub: string,
  sender: string,
  _message: string,
  dest: ToolDest | null = null,
  opts?: { toolChannel?: ToolChannel }
): Promise<string | null> {
  const meta = await readMeta(sub);
  if (!meta) return null;
  // Un agente ACP recibe las tools como herramientas del protocolo; el worker nativo las
  // llama por el SDK de su caja. Es la misma lista con dos formas de invocarla, y decirle la
  // ajena a cualquiera de los dos lo manda a un callejón.
  const porMcp = opts?.toolChannel === "mcp";

  // El alcance del room manda, y se DICE. Un room sin repos no tiene tools de GitHub, y si
  // el modelo no sabe por qué contesta "no tengo acceso a tu código" — que es falso y es la
  // queja que mata un trial de devs. Ver `todo_cuando_falta_algo_el_sistema_calla`.
  const scoped = dest?.channelId ? await roomRepos(dest.channelId) : null;
  if (scoped && !scoped.length) {
    return (
      `[INTEGRACIÓN GitHub de ${sender} (conectada como @${meta.login}), pero ESTE room no tiene ` +
      `ningún repositorio conectado, así que aquí NO tienes herramientas de GitHub. ` +
      `No es que falte la integración ni que no puedas: falta atar el repo a este room. ` +
      `Dile que lo conecte con el botón de GitHub del encabezado del room; y si al abrirlo no ` +
      `aparece ninguno, que revise la integración en Ajustes → Integraciones. ` +
      `No intentes leer código por otra vía ni inventes lo que dice.]`
    );
  }

  return (
    `[INTEGRACIÓN GitHub de ${sender} (conectada como @${meta.login}). ` +
    (scoped
      ? `EN ESTE ROOM trabajas sobre ${scoped.map((r) => r.repo).join(", ")} y SÓLO sobre eso: ` +
        `no consultes ni menciones otros repositorios aunque te los pidan, aquí no existen. ` +
        `Si no dicen cuál, es ${scoped[0].repo}. `
      : "") +
    (porMcp
      ? `TIENES HERRAMIENTAS para sus repos: te llegan como herramientas tuyas y las llamas por su ` +
        `nombre, directamente. NO busques un SDK ni un archivo que importar. `
      : `TIENES HERRAMIENTAS para sus repos vía el GS Tools SDK: importa /opt/gs-sdk/connectors.mjs y usa ` +
        `list() y run(name, args). `) +
    `Lectura: github_list_repos, github_list_issues, github_get_issue, ` +
    `github_list_prs, github_get_pr, github_pr_files, github_read_file, github_search_code, ` +
    `github_checkout, github_workflow_runs, github_workflow_run_logs, github_pr_checks. Escritura: github_create_review, github_merge_pr, github_comment, github_update_issue, github_create_issue, ` +
    `github_create_branch, github_write_file, github_push_files, github_delete_file, github_create_pr, github_update_pr, github_mark_ready, github_enable_auto_merge, ` +
    `github_update_branch, github_update_pr_base, github_watch_pr. ` +
    `También: ramas, colaboradores, releases y tags (github_create_release), etiquetas del repo, ` +
    `workflows de Actions (github_run_workflow, github_cancel_workflow_run), avisos de code scanning y ` +
    `secret scanning, rulesets, sub-issues, discussions, crear repo (github_create_repo; una app nueva se publica con su repo y deploy en cada push a main con publishSite({ title, app: { dir, repo } })), fork y borrar repo (github_delete_repo: SIEMPRE ` +
    `confirma nombrando el repo). ` +
    notaNombres(opts?.toolChannel) +
    `Si te piden "conecta mi repo" o "agrega este repo", contesta con github_install_link. ` +
    `Para CUALQUIER pregunta sobre repos, issues, pull requests o CI de ${sender}, USA estas tools — ` +
    `NO inventes datos ni digas que no tienes acceso (SÍ lo tienes). El repo va como "dueño/repo". ` +
    `Antes de opinar de un PR lee su DIFF con github_pr_files, no sólo el título. ` +
    // Blue se salió a raw.githubusercontent.com al toparse con un archivo truncado.
    // Funciona en un repo público y da 404 en uno privado — los del cliente.
    `Para leer un archivo usa SIEMPRE github_read_file, nunca raw.githubusercontent.com ni un fetch ` +
    `directo: en un repo privado eso falla. Si viene truncated, sigue con el nextOffset que te da. ` +
    // Antes de github_checkout la respuesta correcta ERA "no puedo ejecutar". Ya no:
    // decirlo hoy es falso, y es la queja que mata un trial de devs.
    `SÍ PUEDES EJECUTAR el código: para correr tests, compilar, lint, reproducir un bug o LEVANTAR ` +
    `UNA PREVIEW DE UN PR (staging), lee PRIMERO la skill dev-test (está en tu directorio de ` +
    `skills) y sigue su flujo — NUNCA contestes que no puedes ejecutar código sin haberla leído. ` +
    `Para la preview de un PR: github_checkout con \`pr: N\` (trae su HEAD) y la caja con la ` +
    `etiqueta que te devuelve en \`boxLabel\`. La liga sale PRIVADA y con llave: entrégala ` +
    `COMPLETA y comenta también en el PR para que la vea el equipo. Si la app pide variables que ` +
    `no están, dilo y para: se guardan en Ajustes → Credenciales de gs — NUNCA pidas que te peguen ` +
    `secretos en el chat. ` +
    // ⚠️ Esto vive AQUÍ y no sólo en la skill porque el 2026-08-08 el agente, teniendo la
    // skill correcta en su caja, NO llamó a github_checkout: se puso a averiguar si el repo
    // era público para bajarlo por una URL abierta. Funcionó de casualidad (ese repo lo era)
    // y con un repo de cliente —privados todos— habría fallado diciendo que no puede.
    // ⚠️ El 19 ago 2026 un agente ACP hizo `which gh`, no lo encontró, y en vez de decirlo
    // REDACTÓ el issue en un artefacto y lo entregó como si fuera lo pedido. Cerrar sólo la
    // vía del `gh` no basta: hay que prohibir también el SUCEDÁNEO, o el modelo encuentra
    // otro. Un "no puedo" es una respuesta correcta; un sustituto plausible es una mentira.
    `NO HAY \`gh\` NI CREDENCIALES DE GIT en tu caja, y no los instales: no falla por un error ` +
    `tuyo, es que esa vía no existe. Todo GitHub pasa por estas herramientas. Y si de verdad no ` +
    `las tienes en este turno, DILO — no redactes en un documento lo que te pidieron crear, ni ` +
    `entregues un borrador como si fuera la cosa hecha. ` +
    `CÓMO ENTRA EL CÓDIGO A LA CAJA DE TRABAJO, sin excepciones: llama a github_checkout, que te ` +
    `devuelve una URL de descarga, y haz \`curl\` de ESA URL DENTRO de la caja. Funciona igual con ` +
    `repos PRIVADOS —la URL va firmada y no necesita credencial—, así que está PROHIBIDO ponerte a ` +
    `averiguar si el repo es público, buscarlo por otra vía, o pasar el código con write(). ` +
    `Al terminar un run de tests cierra con el bloque \`\`\`gt-tests que esa skill te enseña. ` +
    `Para escribir código: crea una rama con github_create_branch, escribe con github_write_file y abre ` +
    `un PR con github_create_pr — NUNCA escribas directo sobre la rama principal. ` +
    // El ciclo de un PR sin quedarse esperando: el turno TERMINA y la plataforma lo despierta.
    // Sin decirlo aquí, el modelo se quedaba haciendo polling de CI dentro del turno.
    `CICLO DE UN PR: ábrelo como borrador (draft: true), llama a github_watch_pr y TERMINA el turno ` +
    `diciendo que avisas — la plataforma te despierta aquí mismo cuando CI termina. NUNCA te quedes ` +
    `consultando CI en bucle. Al despertar: si falló, lee el log y arréglalo; si pasó, github_mark_ready ` +
    `y, si te pidieron mergear, github_enable_auto_merge (o github_merge_pr si el repo no lo permite) ` +
    `y vuelve a vigilarlo. En PRs apilados, cuando se mergee el de abajo: github_update_pr_base a la ` +
    `principal y github_update_branch. ` +
    `Todo lo que escribas aparece con el nombre de ${sender}, así que confirma con él antes de comentar, ` +
    `cerrar un issue o abrir un PR. ` +
    // ⚠️ Esto vive AQUÍ y no sólo en la skill `dev-github` a propósito. El 2026-08-05 el
    // agente revisó un PR impecablemente —leyó el diff, dio veredicto— y NO emitió la
    // tarjeta: nunca abrió la skill. Con claude-worker las skills se autodescubren, y
    // "autodescubrible" no es "leída". El contexto ambiental, en cambio, se inyecta en
    // CADA turno de GitHub y no depende de que el modelo decida abrir un archivo.
    `OBLIGATORIO al terminar de revisar un PR, o justo después de abrir uno: cierra tu ` +
    `respuesta con un bloque \`\`\`gt-pr con este JSON en una línea: ` +
    `{"repo":"dueño/repo","number":N,"title":"…","author":"…","additions":N,"deletions":N,` +
    `"files":N,"checks":"success|failure|pending","url":"…","verdict":"tu conclusión en una línea"}. ` +
    `Si levantaste un staging de ese PR, añade "preview":"<la liga COMPLETA, con su ?k=>" y la ` +
    `tarjeta le pone el botón para abrirlo. ` +
    `Le pinta a la persona los botones de Aprobar / Pedir cambios / Rechazar / Mergear, que se ejecutan ` +
    // Sin los anclados el análisis acaba en un bloque de texto que alguien tiene que
    // trasladar a mano. Es la diferencia entre una reseña y un code review.
    `con SU cuenta. Y METE ADEMÁS un array "comments":[{"path","line","body"}] con cada hallazgo ` +
    `que puedas situar en una línea: aparecen anclados JUNTO al código en GitHub. La "line" es la ` +
    `del archivo NUEVO y debe caer dentro del diff; si dudas de una, NO la ancles —GitHub rechaza ` +
    `el review entero con un 422 si una sola está mal—. `+
    `con SU cuenta. Pon SÓLO campos que hayas leído de verdad (los conteos salen de github_get_pr ` +
    `y github_pr_files; \`checks\` de github_pr_checks) — si no lo miraste, omite el campo, ` +
    `nunca lo inventes. La reseña va FUERA del fence, como prosa normal. ` +
    // Dos veces en la misma respuesta el modelo ofreció "¿lo apruebo con github_create_review?".
    // Es fontanería: la persona no sabe ni tiene por qué saber cómo se llaman las tools.
    `Y como la tarjeta YA trae los botones, NO preguntes "¿lo apruebo?" ni menciones el nombre ` +
    `de ninguna tool en tu respuesta — eso es fontanería nuestra, no algo que la persona deba leer.]`
  );
}

// ── Tools ────────────────────────────────────────────────────────────────────

const str = (description: string) => ({ type: "string", description });

// Binarios (imágenes, PDFs, fuentes): `content` es texto y se codifica como UTF-8, así que un
// JPEG pasado por ahí llegaba corrupto y @build se quedaba parado pidiéndole a un humano que lo
// subiera. Ahora el archivo llega por `fromUrl` (la liga de descarga que ya dio el agente) o
// `contentBase64`. `fromUrl` sólo acepta NUESTRO almacenamiento: la petición sale de nuestra red
// y una URL libre sería SSRF.
const BINARY_HOSTS = ["t3.storage.dev", "tigris.dev", "ghosty.studio"];
const MAX_BINARY = 10 * 1024 * 1024;

async function binaryContent(a: Record<string, any>): Promise<{ b64: string } | { error: string } | null> {
  if (typeof a.contentBase64 === "string" && a.contentBase64.trim()) {
    const b64 = a.contentBase64.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return { error: "`contentBase64` no es base64 válido." };
    if (b64.length * 0.75 > MAX_BINARY) return { error: "El archivo pasa de 10 MB." };
    return { b64 };
  }
  if (typeof a.fromUrl !== "string" || !a.fromUrl.trim()) return null;
  const allowed = (u: URL) => {
    const host = u.hostname.toLowerCase();
    return u.protocol === "https:" && !u.port && !u.username && BINARY_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  };
  let u: URL;
  try {
    u = new URL(a.fromUrl.trim());
  } catch {
    return { error: "`fromUrl` no es una URL." };
  }
  // Las ligas de ghosty.studio redirigen a la firmada: cada salto se revalida contra la lista.
  let r: Response | null = null;
  for (let hop = 0; hop < 4; hop++) {
    if (!allowed(u))
      return { error: `\`fromUrl\` sólo acepta ligas https de nuestro almacenamiento (${BINARY_HOSTS.join(", ")}). Publica el archivo primero y pasa esa liga.` };
    const res = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(30_000) }).catch((e) => String(e?.message ?? e));
    if (typeof res === "string") return { error: `No pude descargar el archivo: ${res}` };
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!loc) { r = res; break; }
    u = new URL(loc, u);
  }
  if (!r) return { error: "Demasiadas redirecciones." };
  if (!r.ok) return { error: `No pude descargar el archivo: HTTP ${r.status}${r.status === 403 ? " (¿la liga caducó?)" : ""}.` };
  if (Number(r.headers.get("content-length") ?? 0) > MAX_BINARY) return { error: "El archivo pasa de 10 MB." };
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_BINARY) return { error: "El archivo pasa de 10 MB." };
  if (!buf.length) return { error: "La liga devolvió un archivo vacío." };
  return { b64: buf.toString("base64") };
}

const binaryProps = {
  fromUrl: str("Para BINARIOS (imagen, PDF, fuente): liga https de nuestro almacenamiento (la de descarga de un archivo publicado). Se baja y se commitea byte a byte. En lugar de `content`."),
  contentBase64: str("Para binarios chicos: el archivo en base64. En lugar de `content`."),
};
const repoProp = { repo: str('Repositorio como "dueño/repo".') };

/** El 403 de `apiWith` viene crudo («GitHub respondió 403»), no traducido como el de `api`. */
const denied = (r: any) => /\b403\b|Sin permiso|Resource not accessible/i.test(String(r?.error ?? ""));

const trimRelease = (r: any) => ({
  id: r?.id,
  tag: r?.tag_name,
  name: r?.name,
  draft: !!r?.draft,
  prerelease: !!r?.prerelease,
  author: r?.author?.login ?? null,
  publishedAt: r?.published_at,
  url: r?.html_url,
  body: typeof r?.body === "string" ? r.body.slice(0, 4000) : null,
  assets: (r?.assets ?? []).map((x: any) => ({ name: x?.name, size: x?.size, downloads: x?.download_count, url: x?.browser_download_url })),
});

const trimLabel = (l: any) => ({ name: l?.name, color: l?.color, description: l?.description ?? null });

/** Gists son permiso de CUENTA, no de repo: no hay instalación de repo a la cual mandar. */
const gistError = (r: any) =>
  /Sin permiso/.test(String(r?.error ?? ""))
    ? { error: `A la GitHub App de Ghosty le falta el permiso de cuenta «Gists». La persona lo acepta en ${MANAGE_URL} (abre la instalación de Ghosty → «Accept new permissions»).` }
    : r;

const ALL_TOOLS: ConnectorTool[] = [
  {
    name: "github_list_repos",
    description:
      "Repositorios a los que llega la instalación, o sea los que el usuario eligió al conectar. Si un repo no sale aquí, ninguna otra tool lo va a encontrar.",
    inputSchema: { type: "object", properties: {} },
    handler: async (sub) => {
      const r = await api(sub, "/user/installations");
      if (r?.error) return r;
      const installs: any[] = r?.installations ?? [];
      if (!installs.length) {
        // ⚠️ Redacción deliberada. La versión anterior decía "no está instalada"
        // y el modelo la parafraseaba como "no tienes GitHub conectado", que es
        // FALSO y contradecía lo que él mismo acababa de decir. En GitHub
        // conectar e instalar son cosas independientes, así que el mensaje
        // afirma primero lo que sí es cierto.
        return {
          connected: true,
          installed: false,
          installUrl: INSTALL_URL,
          error:
            "GitHub está CONECTADO correctamente — no le digas al usuario lo contrario. Lo que falta es " +
            `instalar la app de Ghosty en su cuenta y elegir a qué repositorios darle acceso: ${INSTALL_URL}. ` +
            "Dale ese enlace tal cual y dile que ahí escoge los repos. Recomienda «All repositories»: así los repos que Ghosty cree entran solos. Si prefiere elegir, que marque cada repo.",
        };
      }
      // Un usuario puede tener la app instalada en su cuenta personal Y en
      // varias organizaciones. Tomar sólo la primera dejaba invisibles los repos
      // del trabajo, que suelen ser los que importan.
      const perInstall = await Promise.all(
        installs.map(async (inst) => {
          // Por páginas de 100 (hasta 1000): con sólo la primera, una cuenta con más repos «no veía»
          // repos que sí estaban en la instalación (blissito/ghosty-studio, 19-oct).
          const all: any[] = [];
          for (let page = 1; page <= 10; page++) {
            const repos = await api(sub, `/user/installations/${inst.id}/repositories?per_page=100&page=${page}`);
            const batch: any[] = repos?.repositories ?? [];
            all.push(...batch);
            if (batch.length < 100) break;
          }
          return all.map((x: any) => ({
            repo: x?.full_name,
            owner: inst?.account?.login ?? null,
            private: x?.private,
            defaultBranch: x?.default_branch,
            language: x?.language,
            description: x?.description,
            pushedAt: x?.pushed_at,
          }));
        }),
      );
      return {
        repos: perInstall.flat(),
        accounts: installs.map((i) => i?.account?.login).filter(Boolean),
        addMoreUrl: INSTALL_URL,
      };
    },
  },
  {
    name: "github_install_link",
    description:
      "Devuelve los enlaces para instalar la app de Ghosty en una cuenta de GitHub, o para cambiar a qué repositorios tiene acceso. Úsala cuando pidan 'conecta mi repo', 'agrega este repo' o cuando otra tool falle porque el repo no está en la instalación. Recomienda «All repositories» (los repos que crees entran solos).",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ({
      // Es la misma liga para instalar y para agregar repos a una cuenta donde
      // ya está instalada: GitHub reconoce el estado y muestra la pantalla que
      // toca. Por eso no hay que decidir cuál mandar.
      instalarOAgregarRepos: INSTALL_URL,
      administrarInstalaciones: MANAGE_URL,
      recomendado: "Elegir «All repositories»: así los repos que Ghosty cree entran solos. Si la persona prefiere elegir, que marque cada repo.",
    }),
  },
  {
    name: "github_create_repo",
    description:
      "Crea un repositorio NUEVO en la cuenta de GitHub de la persona (o en una de sus organizaciones con `org`) y lo da de alta en la app de Ghosty, " +
      "para que las demás tools y la publicación de apps (site_publish con app.repo) ya lo alcancen. Nace privado y con README en `main`. " +
      "Úsala tú cuando haga falta un repo («súbelo a GitHub», «quiero mi código en un repo»): no le pidas a la persona que lo cree.",
    inputSchema: {
      type: "object",
      properties: {
        name: str("Nombre del repo (letras, números, - _ .)."),
        description: str("Opcional: descripción corta."),
        private: { type: "boolean", description: "Privado (default true)." },
        org: str("Opcional: organización donde crearlo. Sin ella, en la cuenta personal."),
      },
      required: ["name"],
    },
    handler: async (sub, a) => {
      const name = String(a.name ?? "").trim();
      if (!/^[\w.-]{1,100}$/.test(name)) return { error: "Nombre inválido: sólo letras, números, guiones, guion bajo y punto." };
      const org = String(a.org ?? "").trim();
      const body = JSON.stringify({ name, description: String(a.description ?? "").slice(0, 300) || undefined, private: a.private !== false, auto_init: true });
      const repo = await api(sub, org ? `/orgs/${encodeURIComponent(org)}/repos` : "/user/repos", { method: "POST", body });
      if (repo?.error) {
        // 422 = ya existe con ese nombre (u otra validación): se dice tal cual para que elija otro.
        return { error: `${repo.error} Si ya existe un repo con ese nombre, usa otro o trabaja sobre ese.` };
      }
      const full = String(repo?.full_name ?? "");
      const owner = String(repo?.owner?.login ?? "");
      // Al crearlo con el token de la persona NO entra solo a una instalación de «repos elegidos», y
      // GitHub no deja agregarlo con este token (PUT /user/installations/../repositories sólo acepta
      // PAT clásicos). Con «All repositories» entra solo; si no, se le da la liga EXACTA de su
      // instalación para marcarlo (un clic) — nunca «instala la app» si ya está instalada.
      const inst = await api(sub, "/user/installations");
      const mine = ((inst?.installations ?? []) as any[]).find((i) => String(i?.account?.login ?? "").toLowerCase() === owner.toLowerCase());
      let aviso: string | null = null;
      if (!mine) {
        aviso = `El repo se creó, pero la app de Ghosty no está instalada en ${owner}: sin eso no puedo escribir en él. Pásale a la persona esta liga para instalarla y elegir el repo: ${INSTALL_URL}`;
      } else if (mine.repository_selection !== "all") {
        const added = await api(sub, `/user/installations/${mine.id}/repositories/${repo.id}`, { method: "PUT" });
        if (added?.error) {
          const url = String(mine?.account?.type ?? "") === "Organization"
            ? `https://github.com/organizations/${owner}/settings/installations/${mine.id}`
            : `https://github.com/settings/installations/${mine.id}`;
          aviso =
            `El repo se creó. La app de Ghosty YA está instalada en ${owner}, pero sólo con repos elegidos, y GitHub no me deja agregar este repo yo solo. ` +
            `Pásale esta liga: ahí marca ${full} en «Only select repositories» (o elige «All repositories» para que los repos que yo cree entren solos) y guarda: ${url}`;
        }
      }
      return {
        repo: full,
        url: repo?.html_url,
        defaultBranch: repo?.default_branch ?? "main",
        private: repo?.private,
        ...(aviso ? { aviso } : {}),
      };
    },
  },
  {
    name: "github_list_issues",
    description:
      "Issues de un repo. Por default los abiertos. OJO: GitHub cuenta los PRs como issues — cada resultado trae isPullRequest para distinguirlos.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        state: str("open | closed | all. Default open."),
        labels: str("Etiquetas separadas por coma."),
        assignee: str('Login de quien lo tiene asignado, o "none".'),
        limit: { type: "number", description: "1-100, default 25." },
      },
      required: ["repo"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const r = await api(
        sub,
        `/repos/${p}/issues` +
          qs({ ...a, state: a.state ?? "open", per_page: a.limit ?? 25 }, ["state", "labels", "assignee", "per_page"]),
      );
      return Array.isArray(r) ? r.map(trimIssue) : r;
    },
  },
  {
    name: "github_get_issue",
    description: "Un issue con TODOS sus comentarios. Es lo que hay que leer antes de trabajar en algo.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, number: { type: "number", description: "Número del issue." } },
      required: ["repo", "number"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const issue = await api(sub, `/repos/${p}/issues/${Number(a.number)}`);
      if (issue?.error) return issue;
      const comments = await api(sub, `/repos/${p}/issues/${Number(a.number)}/comments?per_page=50`);
      return {
        ...trimIssue(issue),
        thread: Array.isArray(comments)
          ? comments.map((c: any) => ({
              author: c?.user?.login,
              at: c?.created_at,
              body: typeof c?.body === "string" ? c.body.slice(0, 3000) : null,
            }))
          : [],
      };
    },
  },
  {
    name: "github_list_prs",
    description: "Pull requests de un repo. Por default los abiertos.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        state: str("open | closed | all. Default open."),
        limit: { type: "number", description: "1-100, default 25." },
      },
      required: ["repo"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const r = await api(
        sub,
        `/repos/${p}/pulls` + qs({ state: a.state ?? "open", per_page: a.limit ?? 25 }, ["state", "per_page"]),
      );
      return Array.isArray(r) ? r.map(trimPr) : r;
    },
  },
  {
    name: "github_get_pr",
    description:
      "Un pull request con sus comentarios y los de revisión. Para ver QUÉ cambia usa github_pr_files.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, number: { type: "number", description: "Número del PR." } },
      required: ["repo", "number"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const n = Number(a.number);
      const pr = await api(sub, `/repos/${p}/pulls/${n}`);
      if (pr?.error) return pr;
      const [comments, reviews] = await Promise.all([
        api(sub, `/repos/${p}/issues/${n}/comments?per_page=50`),
        api(sub, `/repos/${p}/pulls/${n}/reviews?per_page=50`),
      ]);
      return {
        ...trimPr(pr),
        thread: Array.isArray(comments)
          ? comments.map((c: any) => ({ author: c?.user?.login, at: c?.created_at, body: c?.body?.slice(0, 3000) }))
          : [],
        reviews: Array.isArray(reviews)
          ? reviews.map((r: any) => ({ author: r?.user?.login, state: r?.state, body: r?.body?.slice(0, 2000) }))
          : [],
      };
    },
  },
  {
    name: "github_pr_files",
    description:
      "El DIFF de un pull request, archivo por archivo. Léelo antes de opinar de un PR — el título miente. Los parches muy grandes vienen recortados y se dice cuáles.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        number: { type: "number", description: "Número del PR." },
        limit: { type: "number", description: "Archivos a devolver. 1-100, default 40." },
      },
      required: ["repo", "number"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const r = await api(sub, `/repos/${p}/pulls/${Number(a.number)}/files?per_page=${Number(a.limit) || 40}`);
      if (!Array.isArray(r)) return r;
      // Un PR grande trae megabytes de parches. Se recorta por archivo y se
      // AVISA cuál quedó truncado, para que el modelo no dictamine sobre medio
      // diff creyendo que lo vio entero.
      const MAX = 8000;
      return r.map((f: any) => {
        const patch: string = f?.patch ?? "";
        return {
          file: f?.filename,
          status: f?.status,
          additions: f?.additions,
          deletions: f?.deletions,
          patch: patch.length > MAX ? patch.slice(0, MAX) : patch || null,
          patchTruncated: patch.length > MAX,
        };
      });
    },
  },
  {
    name: "github_read_file",
    description:
      "Contenido de un archivo del repo. Sirve para entender el código antes de cambiarlo. Si viene `truncated: true`, pide el resto con `offset` — NUNCA te salgas a raw.githubusercontent.com: en un repo privado eso da 404.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        path: str("Ruta del archivo dentro del repo."),
        ref: str("Rama, tag o SHA. Default: la rama principal."),
        offset: {
          type: "number",
          description: "Carácter desde el que empezar. Para seguir leyendo un archivo que vino truncado: usa el `nextOffset` que te devolvió.",
        },
      },
      required: ["repo", "path"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const r = await api(sub, `/repos/${p}/contents/${String(a.path)}` + qs(a, ["ref"]));
      if (r?.error) return r;
      if (Array.isArray(r)) return { directory: r.map((x: any) => ({ name: x?.name, type: x?.type })) };
      if (r?.encoding !== "base64") return { error: "Ese archivo no es texto." };
      const full = Buffer.from(r.content, "base64").toString("utf8");
      // ⚠️ Sin `offset`, un archivo de más de 60k dejaba al modelo sin salida dentro de la
      // tool y se iba a raw.githubusercontent.com — que funciona en un repo público y da
      // 404 en uno privado, que son justo los del cliente. Visto en vivo el 2026-08-05.
      const from = Math.max(0, Number(a.offset) || 0);
      const LIMIT = 60_000;
      const content = full.slice(from, from + LIMIT);
      const end = from + content.length;
      return {
        path: r.path,
        // El `sha` es OBLIGATORIO para sobrescribir después con github_write_file.
        sha: r.sha,
        size: r.size,
        chars: full.length,
        from,
        truncated: end < full.length,
        ...(end < full.length ? { nextOffset: end, comoSeguir: `Vuelve a llamar con offset: ${end}` } : {}),
        content,
      };
    },
  },
  {
    name: "github_checkout",
    description:
      'Copia de trabajo del repo para EJECUTAR su código: correr tests, compilar, lint, reproducir un bug. ' +
      'Default: devuelve una URL efímera de descarga del tarball (bájala YA con curl -L | tar xz; no trae .git). ' +
      'Con mode:"git" devuelve un clone real con historia (token de 1 h, sólo lectura). ' +
      "Para LEER un archivo suelto sigue siendo github_read_file — esto es para ejecutar.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        ref: str("Rama, tag o SHA. Default: la rama principal."),
        pr: {
          type: "number",
          description:
            "Número de PR. Trae el código TAL COMO QUEDA en ese pull request (su head), que es lo que hay que levantar para una preview. Gana sobre `ref`.",
        },
        mode: {
          type: "string",
          enum: ["tarball", "git"],
          description:
            'Default "tarball": URL de descarga sin credencial. "git": clone con historia (git log, blame, diff local).',
        },
      },
      required: ["repo"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      // Con el token del USUARIO a propósito: si el solicitante no puede leer el repo,
      // esto falla y ahí se acaba — ningún token del bot debe cubrir lo que GitHub no
      // le deja leer a la persona (el installation token tiene el techo de la App, no
      // la intersección con ella).
      const info = await api(sub, `/repos/${p}`);
      if (info?.error) return info;

      // Con `pr` se baja el HEAD del pull request, que es lo que se levanta en una
      // preview: la rama base no tiene los cambios que se están revisando.
      let ref = String(a.ref || info?.default_branch || "main");
      let prNumber: number | null = null;
      if (a.pr !== undefined && a.pr !== null) {
        const n = Number(a.pr);
        if (!Number.isInteger(n) || n <= 0) return { error: "El número de PR no es válido." };
        const pr = await api(sub, `/repos/${p}/pulls/${n}`);
        if (pr?.error) return pr;
        const head = pr?.head?.sha ?? pr?.head?.ref;
        if (!head) return { error: `No pude resolver el head del PR ${n}.` };
        ref = String(head);
        prNumber = n;
      }

      const commit = await api(sub, `/repos/${p}/commits/${encodeURIComponent(ref)}`);
      const sha = typeof commit?.sha === "string" ? commit.sha : null;
      const repo = normalizeRepo(a.repo);

      if (a.mode === "git") {
        const instId = await installationIdFor(p);
        const repoName = repo?.split("/")[1] ?? null;
        // Recortado a UN repo y con contents en sólo lectura: este token SÍ sale hacia
        // la caja del agente. Escribir sigue siendo del bot vía API (writeToken), que
        // es donde se re-impone el permiso real del solicitante.
        const token =
          instId && repoName ? await installationToken(instId, { onlyRepo: repoName, readOnly: true }) : null;
        if (!token) {
          return {
            error:
              "El modo git necesita la GitHub App instalada en ese repositorio " +
              `(se instala aquí: ${INSTALL_URL}). Mientras tanto usa el modo tarball, que funciona con la conexión del usuario.`,
          };
        }
        return {
          mode: "git",
          repo,
          ref,
          sha,
          ...(prNumber ? { pr: prNumber, boxLabel: `${repo}#${prNumber}` } : {}),
          cloneUrl: `https://x-access-token:${token}@github.com/${repo}.git`,
          expiresInMinutes: 60,
          rules:
            "Clona AHORA y limpia la credencial en cuanto termine: " +
            `git clone --branch ${ref} <cloneUrl> repo && git -C repo remote set-url origin https://github.com/${repo}.git — ` +
            "el token NO debe quedar en .git/config, en remotes ni escrito en ningún archivo. Es de sólo lectura: no intentes push con él.",
        };
      }

      const instId = await installationIdFor(p);
      const botToken = instId ? await installationToken(instId) : null;
      const userToken = botToken ? null : await getValidToken(sub, "github");
      const token = botToken ?? userToken;
      if (!token) {
        return { error: "La cuenta de GitHub no está conectada. Conéctala en Ajustes → Integraciones." };
      }
      const url = await tarballUrl(token, p, ref);
      if (typeof url !== "string") return url;
      return {
        mode: "tarball",
        repo,
        ref,
        sha,
        // La etiqueta con la que se pide la caja: de ella salen el reuso entre turnos y
        // los secretos del repo. Se devuelve ya armada para que el modelo no la invente.
        ...(prNumber ? { pr: prNumber, boxLabel: `${repo}#${prNumber}` } : { boxLabel: repo }),
        url,
        sizeKb: typeof info?.size === "number" ? info.size : null,
        note:
          "La URL caduca en pocos minutos: descárgala YA (curl -L <url> | tar xz --strip-components=1 -C repo/). " +
          "Es un snapshot sin .git — para historia o diffs locales pide mode:\"git\".",
      };
    },
  },
  {
    name: "github_search_code",
    description:
      "Busca texto dentro del código de un repo. Es la forma rápida de encontrar dónde vive algo sin clonar nada.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, q: str("Qué buscar."), limit: { type: "number", description: "1-50, default 20." } },
      required: ["repo", "q"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const r = await api(
        sub,
        `/search/code?q=${encodeURIComponent(`${a.q} repo:${decodeURIComponent(p)}`)}&per_page=${Number(a.limit) || 20}`,
      );
      if (r?.error) return r;
      return { total: r?.total_count, hits: (r?.items ?? []).map((x: any) => ({ file: x?.path, url: x?.html_url })) };
    },
  },
  {
    name: "github_workflow_runs",
    description:
      "Corridas de GitHub Actions, de la más reciente hacia atrás. Sirve para saber POR QUÉ está roja la build.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        branch: str("Limita a una rama."),
        status: str("queued | in_progress | completed | failure | success."),
        limit: { type: "number", description: "1-50, default 10." },
      },
      required: ["repo"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const r = await api(
        sub,
        `/repos/${p}/actions/runs` + qs({ ...a, per_page: a.limit ?? 10 }, ["branch", "status", "per_page"]),
      );
      if (r?.error) return r;
      return (r?.workflow_runs ?? []).map((x: any) => ({
        id: x?.id,
        name: x?.name,
        branch: x?.head_branch,
        event: x?.event,
        status: x?.status,
        conclusion: x?.conclusion,
        at: x?.created_at,
        url: x?.html_url,
      }));
    },
  },

  // ── Escritura ──────────────────────────────────────────────────────────────
  // Todo lo de aquí abajo aparece con el NOMBRE del usuario en GitHub. El
  // ambientContext le dice al modelo que confirme antes de usarlas.

  {
    name: "github_create_review",
    description:
      "Aprueba un pull request, pide cambios, o deja un review con comentarios anclados a líneas concretas del diff. Es distinto de github_comment, que sólo deja un comentario suelto en la conversación. ⚠️ Confírmalo SIEMPRE con el usuario: queda a su nombre y un approve puede desbloquear un merge. GitHub no deja aprobar tu propio PR.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        number: { type: "number", description: "Número del PR." },
        event: str("APPROVE | REQUEST_CHANGES | COMMENT. Default COMMENT."),
        body: str("El texto del review. Obligatorio para REQUEST_CHANGES y COMMENT."),
        comments: {
          type: "array",
          description:
            "Comentarios anclados. Cada uno: {path, line, body}. `line` es el número de línea en el archivo YA modificado, y tiene que estar dentro del diff del PR o GitHub lo rechaza.",
          items: {
            type: "object",
            properties: {
              path: str("Ruta del archivo, tal como sale en github_pr_files."),
              line: { type: "number", description: "Línea en la versión nueva del archivo." },
              body: str("El comentario."),
            },
            required: ["path", "line", "body"],
          },
        },
      },
      required: ["repo", "number"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const event = String(a.event ?? "COMMENT").toUpperCase();
      if (!["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(event)) {
        return { error: `event inválido: ${event}. Usa APPROVE, REQUEST_CHANGES o COMMENT.` };
      }
      // GitHub responde 422 con un texto poco claro si falta el cuerpo en estos dos.
      // Vale más decirlo aquí que devolverle al modelo un error que no sabe interpretar.
      if (event !== "APPROVE" && !String(a.body ?? "").trim()) {
        return { error: `Un review de tipo ${event} necesita \`body\`.` };
      }
      const comments = Array.isArray(a.comments)
        ? (a.comments as any[])
            .map((c) => ({ path: String(c?.path ?? ""), line: Number(c?.line), body: String(c?.body ?? "") }))
            .filter((c) => c.path && Number.isFinite(c.line) && c.body)
        : [];
      const r = await api(sub, `/repos/${p}/pulls/${Number(a.number)}/reviews`, {
        method: "POST",
        body: JSON.stringify({
          event,
          ...(a.body ? { body: String(a.body) } : {}),
          ...(comments.length ? { comments } : {}),
        }),
      });
      if (r?.error) {
        // ⚠️ GitHub prohíbe las DOS sobre tu propio PR, no sólo aprobar: "Review Can not
        // request changes on your own pull request" (422). Sólo un review de tipo COMMENT
        // está permitido sobre lo tuyo.
        const txt = String(r.error);
        if (txt.includes("422") && (event === "APPROVE" || event === "REQUEST_CHANGES")) {
          return {
            error:
              `GitHub no deja ${event === "APPROVE" ? "aprobar" : "pedir cambios en"} tu propio pull request. ` +
              "Que lo haga otra persona del equipo, o deja el análisis como comentario (event: COMMENT).",
          };
        }
        return r;
      }
      return { ok: true, event, id: r?.id, url: r?.html_url, state: r?.state };
    },
  },
  {
    name: "github_merge_pr",
    description:
      "Mergea un pull request. ⚠️ Es la acción menos reversible de todas: confírmala SIEMPRE y no la propongas si el PR no está aprobado o si CI está en rojo.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        number: { type: "number", description: "Número del PR." },
        method: str("squash | merge | rebase. Por defecto el que el repo permita, prefiriendo squash."),
      },
      required: ["repo", "number"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      // El método NO se puede adivinar: pedir uno que el repo tiene deshabilitado devuelve
      // 405 con un mensaje que no dice cuál sí acepta. Se leen los permitidos y se elige.
      const info = await api(sub, `/repos/${p}`);
      if (info?.error) return info;
      const permitidos = [
        info.allow_squash_merge ? "squash" : "",
        info.allow_merge_commit ? "merge" : "",
        info.allow_rebase_merge ? "rebase" : "",
      ].filter(Boolean);
      if (!permitidos.length) return { error: "Ese repositorio no permite mergear desde la API." };
      const pedido = String(a.method ?? "");
      const method = permitidos.includes(pedido) ? pedido : permitidos[0];
      const r = await api(sub, `/repos/${p}/pulls/${Number(a.number)}/merge`, {
        method: "PUT",
        body: JSON.stringify({ merge_method: method }),
      });
      if (r?.error) {
        const txt = String(r.error);
        // Los tres rechazos habituales, que el mensaje genérico deja indescifrables.
        if (txt.includes("405")) return { error: "GitHub dice que este PR no se puede mergear (¿conflictos, o falta una aprobación requerida?)." };
        if (txt.includes("409")) return { error: "La rama cambió desde que se leyó. Vuelve a intentarlo." };
        return r;
      }
      return { ok: true, merged: r?.merged === true, method, message: r?.message };
    },
  },
  {
    name: "github_pr_checks",
    description:
      "Cómo va CI en un pull request AHORA: junta los checks de Actions y los statuses externos (Vercel, etc.) de su último commit. `state` es success | failure | pending | none (none = el repo no tiene CI, NO es verde). Si falló, trae cuáles y su liga; para el porqué, github_workflow_run_logs.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, number: { type: "number", description: "Número del PR." } },
      required: ["repo", "number"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const pr = await api(sub, `/repos/${p}/pulls/${Number(a.number)}`);
      if (pr?.error) return pr;
      const sha = String(pr?.head?.sha ?? "");
      const r = await loadChecks((path) => api(sub, path), p, sha);
      return "error" in r ? r : { ...r, sha: sha.slice(0, 7) };
    },
  },
  {
    name: "github_mark_ready",
    description:
      "Saca un pull request de BORRADOR y lo marca listo para revisión. Úsalo cuando CI ya pasó en un PR que abriste como draft.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, number: { type: "number", description: "Número del PR." } },
      required: ["repo", "number"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const pr = await api(sub, `/repos/${p}/pulls/${Number(a.number)}`);
      if (pr?.error) return pr;
      // Llamarlo sobre un PR que ya está listo es un error de GraphQL poco claro; mejor
      // decirle al modelo que no había nada que hacer.
      if (pr?.draft !== true) return { ok: true, alreadyReady: true };
      const r = await graphql(
        sub,
        `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`,
        { id: pr.node_id },
      );
      return r?.error ? r : { ok: true, draft: r?.markPullRequestReadyForReview?.pullRequest?.isDraft ?? false };
    },
  },
  {
    name: "github_enable_auto_merge",
    description:
      "Enciende el AUTO-MERGE de un pull request: GitHub lo mergea solo en cuanto pasen los checks y las aprobaciones requeridas. ⚠️ Es un merge diferido: confírmalo como confirmarías github_merge_pr. Si el repo no tiene el auto-merge permitido te lo dice, y entonces la salida es esperar a que CI pase (github_watch_pr) y mergear con github_merge_pr.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        number: { type: "number", description: "Número del PR." },
        method: str("squash | merge | rebase. Default squash (o el que el repo permita)."),
      },
      required: ["repo", "number"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const info = await api(sub, `/repos/${p}`);
      if (info?.error) return info;
      // Se dice ANTES de llamar: el error de GraphQL para esto es críptico y el modelo lo
      // leía como un fallo de permisos.
      if (info.allow_auto_merge !== true) {
        return {
          error:
            "Este repositorio tiene el auto-merge DESACTIVADO (Settings → General → Allow auto-merge). " +
            "Sin eso no se puede encender: espera a que pasen los checks y mergea con github_merge_pr.",
          autoMergeDisabled: true,
        };
      }
      // Mismo criterio que github_merge_pr: el método tiene que estar permitido en el repo.
      const permitidos = [
        info.allow_squash_merge ? "squash" : "",
        info.allow_merge_commit ? "merge" : "",
        info.allow_rebase_merge ? "rebase" : "",
      ].filter(Boolean);
      if (!permitidos.length) return { error: "Ese repositorio no permite mergear desde la API." };
      const pedido = String(a.method ?? "squash");
      const method = permitidos.includes(pedido) ? pedido : permitidos[0];
      const pr = await api(sub, `/repos/${p}/pulls/${Number(a.number)}`);
      if (pr?.error) return pr;
      const r = await graphql(
        sub,
        `mutation($id: ID!, $m: PullRequestMergeMethod!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $m }) { pullRequest { autoMergeRequest { mergeMethod } } } }`,
        { id: pr.node_id, m: method.toUpperCase() },
      );
      if (r?.error) {
        const txt = String(r.error).toLowerCase();
        // "clean status" = no hay nada que esperar: ya se puede mergear directo.
        if (txt.includes("clean status")) {
          return { error: "No hay nada que esperar: el PR ya se puede mergear. Usa github_merge_pr." };
        }
        if (txt.includes("not allowed") || txt.includes("auto merge is not")) {
          return {
            error: "GitHub no deja auto-merge en este repositorio. Espera a que pasen los checks y mergea con github_merge_pr.",
            autoMergeDisabled: true,
          };
        }
        if (txt.includes("draft")) return { error: "El PR sigue en borrador: márcalo listo con github_mark_ready primero." };
        return r;
      }
      return { ok: true, autoMerge: true, method };
    },
  },
  {
    name: "github_update_branch",
    description:
      "Trae a la rama del PR lo último de su rama destino (el botón «Update branch» de GitHub). Sirve cuando el PR quedó atrás de main o cuando un PR apilado necesita lo que ya se mergeó debajo. Vuelve a correr CI.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, number: { type: "number", description: "Número del PR." } },
      required: ["repo", "number"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const r = await api(sub, `/repos/${p}/pulls/${Number(a.number)}/update-branch`, { method: "PUT", body: "{}" });
      if (r?.error) {
        // 422 aquí casi siempre es conflicto: eso NO lo resuelve un botón, hay que tocar código.
        if (String(r.error).includes("rechazó")) {
          return {
            error: `GitHub no pudo actualizar la rama (¿conflictos con la base?). ${r.error} Resuélvelo con github_push_files y \`mergeFrom\` = la rama base: commit de merge con los archivos que chocan ya resueltos.`,
          };
        }
        return r;
      }
      return { ok: true, message: r?.message ?? "Actualización encolada; CI vuelve a correr." };
    },
  },
  {
    name: "github_update_pr",
    description:
      "Edita el título o la descripción de un pull request. Úsala para que la descripción diga lo que HOY hace la rama (p. ej. tras corregir hallazgos): una descripción vieja contradice el código.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        number: { type: "number", description: "Número del PR." },
        title: str("Título nuevo (opcional)."),
        body: str("Descripción nueva completa, en markdown (opcional)."),
      },
      required: ["repo", "number"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const patch: Record<string, string> = {};
      if (typeof a.title === "string" && a.title.trim()) patch.title = a.title.trim();
      if (typeof a.body === "string") patch.body = a.body;
      if (!Object.keys(patch).length) return { error: "Pasa title o body." };
      const w = await writeToken(sub, p);
      if ("error" in w) return w;
      const r = await apiWith(w.token, `/repos/${p}/pulls/${Number(a.number)}`, { method: "PATCH", body: JSON.stringify(patch) });
      return r?.error ? r : { ok: true, url: r?.html_url };
    },
  },
  {
    name: "github_update_repo",
    description:
      "Cambia la configuración de un repo de la persona: visibilidad (privado/público), descripción, página web o rama principal. " +
      "Úsala tú cuando lo pida («hazlo privado», «cámbiale la descripción»): no la mandes a Settings. " +
      "Hacerlo PÚBLICO expone todo el código y su historial: confirma con la persona antes y pasa `confirmado: true`.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        private: { type: "boolean", description: "true = privado, false = público." },
        description: str("Descripción nueva (opcional)."),
        homepage: str("Página web del repo (opcional)."),
        default_branch: str("Rama principal nueva (opcional; debe existir)."),
        confirmado: { type: "boolean", description: "Obligatorio en true para hacerlo público." },
      },
      required: ["repo"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const patch: Record<string, unknown> = {};
      if (typeof a.private === "boolean") patch.private = a.private;
      if (typeof a.description === "string") patch.description = a.description.slice(0, 350);
      if (typeof a.homepage === "string") patch.homepage = a.homepage.trim();
      if (typeof a.default_branch === "string" && a.default_branch.trim()) patch.default_branch = a.default_branch.trim();
      if (!Object.keys(patch).length) return { error: "Pasa private, description, homepage o default_branch." };
      if (patch.private === false && a.confirmado !== true) {
        return { error: "Hacerlo público expone el código y todo su historial. Confírmalo con la persona y vuelve a llamar con confirmado: true." };
      }
      // Con el token de la persona: cambiar visibilidad exige que ELLA sea admin del repo (GitHub lo
      // valida) y que la App tenga «Administration: write» sobre él.
      const r = await api(sub, `/repos/${p}`, { method: "PATCH", body: JSON.stringify(patch) });
      if (r?.error) {
        return { error: `${r.error} Si dice «Resource not accessible», la app de Ghosty no tiene ese repo: que lo marque en ${INSTALL_URL} (o elija «All repositories»).` };
      }
      return { ok: true, repo: r?.full_name, private: r?.private, url: r?.html_url, defaultBranch: r?.default_branch };
    },
  },
  // ── Paridad con el MCP oficial de GitHub (github/github-mcp-server), lo que usa la
  // Software Factory: commit de varios archivos, árbol, commits, comentarios en línea del
  // PR, reintentar CI, avisos de Dependabot y búsqueda de issues/PRs.
  {
    name: "github_push_files",
    description:
      "Varios archivos (crear, reemplazar o BORRAR) en UN solo commit sobre una rama de trabajo (nunca la principal). Prefiérela a github_write_file cuando el cambio toca más de un archivo: un commit por archivo deja la rama rota a medias. " +
      "Con `mergeFrom` (p. ej. \"main\") el commit es un MERGE de esa rama en la tuya: así se resuelve un PR con conflictos. Lo que cambió allá y tú no tocaste entra solo; en `files` va el contenido FINAL de los archivos que chocan (si falta uno, te dice cuáles).",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        branch: str("Rama de trabajo."),
        message: str("Mensaje del commit."),
        mergeFrom: str("Opcional: rama (o commit) a fusionar en la tuya con este commit, para resolver conflictos. Normalmente la principal."),
        files: {
          type: "array",
          description: "Cambios. `content` para crear/reemplazar texto; `fromUrl`/`contentBase64` para binarios (imágenes, PDFs); `delete: true` para borrar.",
          items: {
            type: "object",
            properties: { path: str("Ruta."), content: str("Contenido completo (texto)."), ...binaryProps, delete: { type: "boolean" } },
            required: ["path"],
          },
        },
      },
      required: ["repo", "branch", "message", "files"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const files = Array.isArray(a.files) ? (a.files as any[]) : [];
      if (!files.length) return { error: "Sin archivos." };
      if (files.length > 100) return { error: "Máximo 100 archivos por commit." };
      for (const f of files) {
        if (!f?.path) return { error: "Cada archivo lleva `path`." };
        if (!f.delete && typeof f.content !== "string" && !f.fromUrl && !f.contentBase64)
          return { error: `${f.path}: falta \`content\` (o \`fromUrl\`/\`contentBase64\`, o \`delete: true\`).` };
      }
      const w = await writeToken(sub, p);
      if ("error" in w) return w;
      const branch = String(a.branch ?? "").trim();
      const info = await apiWith(w.token, `/repos/${p}`);
      if (info?.error) return info;
      if (!branch || branch === String(info?.default_branch ?? "main"))
        return { error: "No se commitea en la rama principal: usa tu rama de trabajo y entra por PR." };
      const ref = await apiWith(w.token, `/repos/${p}/git/ref/heads/${encodeURIComponent(branch)}`);
      if (ref?.error) return { error: `No encuentro la rama ${branch}: ${ref.error}` };
      const parent = String(ref?.object?.sha ?? "");
      const base = await apiWith(w.token, `/repos/${p}/git/commits/${parent}`);
      if (base?.error) return base;
      const clean = (x: string) => String(x).replace(/^\/+/, "");
      // Los binarios van como blob base64 aparte: `content` del árbol sólo admite texto.
      const entries: Record<string, unknown>[] = [];
      for (const f of files) {
        if (f.delete) { entries.push({ path: clean(f.path), mode: "100644", type: "blob", sha: null }); continue; }
        const bin = await binaryContent(f);
        if (bin && "error" in bin) return { error: `${f.path}: ${bin.error}` };
        if (!bin) { entries.push({ path: clean(f.path), mode: "100644", type: "blob", content: String(f.content) }); continue; }
        const blob = await apiWith(w.token, `/repos/${p}/git/blobs`, { method: "POST", body: JSON.stringify({ content: bin.b64, encoding: "base64" }) });
        if (blob?.error) return { error: `${f.path}: ${blob.error}` };
        entries.push({ path: clean(f.path), mode: "100644", type: "blob", sha: blob?.sha });
      }
      // MERGE (choques de un PR): el commit lleva DOS padres, la rama y `mergeFrom`. El árbol es
      // el de la rama + lo que cambió en `mergeFrom` desde el ancestro común y la rama no tocó
      // (entra solo) + lo que manda el agente (los que chocan, ya resueltos). Un archivo que
      // cambiaron los dos lados y no viene en `files` es un choque sin resolver: se rechaza en
      // vez de pisar en silencio el cambio de la principal.
      const parents = [parent];
      if (a.mergeFrom) {
        const fromRef = String(a.mergeFrom).trim();
        const r2 = /^[0-9a-f]{40}$/i.test(fromRef) ? { object: { sha: fromRef } } : await apiWith(w.token, `/repos/${p}/git/ref/heads/${encodeURIComponent(fromRef)}`);
        const fromSha = String(r2?.object?.sha ?? "");
        if (!fromSha) return { error: `No encuentro ${fromRef} para fusionar.` };
        const [theirs, ours] = await Promise.all([
          apiWith(w.token, `/repos/${p}/compare/${parent}...${fromSha}`),
          apiWith(w.token, `/repos/${p}/compare/${fromSha}...${parent}`),
        ]);
        if (theirs?.error || ours?.error) return { error: `No pude comparar las ramas: ${theirs?.error ?? ours?.error}` };
        if (Number(theirs?.ahead_by ?? 0) === 0) return { error: `${fromRef} no trae nada nuevo: no hace falta fusionar.` };
        // La API de compare corta en 300 archivos: con más, el merge declararía a la principal como
        // padre sin traer todo lo suyo y al mezclar se REVERTIRÍA. Mejor no hacerlo.
        if ((theirs?.files ?? []).length >= 300 || (ours?.files ?? []).length >= 300)
          return { error: `Son demasiados archivos para fusionar por la API (≥300). Hay que traer ${fromRef} con git normal.` };
        // Modos reales (ejecutables, symlinks) del árbol de la principal: no todo es 100644.
        const fromTree = await apiWith(w.token, `/repos/${p}/git/trees/${fromSha}?recursive=1`);
        const modeOf = new Map<string, string>(((fromTree?.tree ?? []) as any[]).map((t) => [String(t.path), String(t.mode)]));
        const mine = new Set(entries.map((e) => String(e.path)));
        const touchedHere = new Set<string>(((ours?.files ?? []) as any[]).flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)));
        const pendientes: string[] = [];
        for (const f of (theirs?.files ?? []) as any[]) {
          const path = String(f.filename);
          if (mine.has(path)) continue;
          if (touchedHere.has(path) || (f.previous_filename && touchedHere.has(f.previous_filename))) { pendientes.push(path); continue; }
          if (f.status === "removed") entries.push({ path, mode: "100644", type: "blob", sha: null });
          else {
            if (f.status === "renamed" && f.previous_filename && !mine.has(f.previous_filename))
              entries.push({ path: f.previous_filename, mode: "100644", type: "blob", sha: null });
            const mode = modeOf.get(path) ?? "100644";
            if (mode === "160000") { pendientes.push(path); continue; } // submódulo: a mano
            entries.push({ path, mode, type: "blob", sha: f.sha });
          }
        }
        if (pendientes.length)
          return {
            error:
              `Conflictos sin resolver: ${pendientes.join(", ")} cambiaron en ${fromRef} y en tu rama. Lee las dos versiones ` +
              `(github_read_file con ref) y manda en \`files\` el contenido final de cada uno (o \`delete: true\` si en tu rama ya no existe y su cambio se movió a otro archivo).`,
          };
        parents.push(fromSha);
      }
      const tree = await apiWith(w.token, `/repos/${p}/git/trees`, {
        method: "POST",
        body: JSON.stringify({ base_tree: base?.tree?.sha, tree: entries }),
      });
      if (tree?.error) return tree;
      const meta = w.bot ? await readMeta(sub) : null;
      const message = String(a.message) + (meta?.login ? coAuthorTrailer(meta.login) : "");
      const commit = await apiWith(w.token, `/repos/${p}/git/commits`, {
        method: "POST",
        body: JSON.stringify({ message, tree: tree?.sha, parents }),
      });
      if (commit?.error) return commit;
      const moved = await apiWith(w.token, `/repos/${p}/git/refs/heads/${encodeURIComponent(branch)}`, {
        method: "PATCH",
        body: JSON.stringify({ sha: commit?.sha }),
      });
      if (moved?.error) return moved;
      return { ok: true, commit: commit?.sha, files: files.length, deleted: files.filter((f) => f.delete).length, asBot: w.bot, ...(parents.length > 1 ? { merged: String(a.mergeFrom) } : {}) };
    },
  },
  {
    name: "github_repo_tree",
    description: "El árbol COMPLETO de archivos del repo (o de una rama) en una sola llamada, para ubicarse antes de leer. Si es enorme, filtra con `prefix`.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, ref: str("Rama o commit. Default: la principal."), prefix: str("Sólo rutas que empiezan así (p. ej. app/routes/).") },
      required: ["repo"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      let ref = String(a.ref ?? "").trim();
      if (!ref) {
        const info = await api(sub, `/repos/${p}`);
        if (info?.error) return info;
        ref = String(info?.default_branch ?? "main");
      }
      const r = await api(sub, `/repos/${p}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
      if (r?.error) return r;
      const prefix = String(a.prefix ?? "");
      const paths = (Array.isArray(r?.tree) ? r.tree : [])
        .filter((e: any) => e?.type === "blob" && String(e.path).startsWith(prefix))
        .map((e: any) => String(e.path));
      return { ref, count: paths.length, paths: paths.slice(0, 3000), truncated: !!r?.truncated || paths.length > 3000 };
    },
  },
  {
    name: "github_list_commits",
    description: "Los últimos commits de una rama (o de una ruta): quién cambió qué y cuándo.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, ref: str("Rama. Default: la principal."), path: str("Sólo los que tocan esta ruta."), since: str("Desde esta fecha ISO.") },
      required: ["repo"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const q = new URLSearchParams({ per_page: "30" });
      if (a.ref) q.set("sha", String(a.ref));
      if (a.path) q.set("path", String(a.path));
      if (a.since) q.set("since", String(a.since));
      const r = await api(sub, `/repos/${p}/commits?${q}`);
      if (r?.error) return r;
      return (Array.isArray(r) ? r : []).map((c: any) => ({
        sha: String(c?.sha ?? "").slice(0, 12),
        author: c?.author?.login ?? c?.commit?.author?.name,
        date: c?.commit?.author?.date,
        message: String(c?.commit?.message ?? "").split("\n")[0].slice(0, 200),
      }));
    },
  },
  {
    name: "github_get_commit",
    description: "Un commit: su mensaje completo y qué archivos cambió (con +/−).",
    inputSchema: { type: "object", properties: { ...repoProp, sha: str("SHA del commit.") }, required: ["repo", "sha"] },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const r = await api(sub, `/repos/${p}/commits/${encodeURIComponent(String(a.sha))}`);
      if (r?.error) return r;
      return {
        sha: r?.sha,
        author: r?.author?.login ?? r?.commit?.author?.name,
        date: r?.commit?.author?.date,
        message: r?.commit?.message,
        files: (Array.isArray(r?.files) ? r.files : []).slice(0, 100).map((f: any) => ({ path: f?.filename, status: f?.status, additions: f?.additions, deletions: f?.deletions })),
      };
    },
  },
  {
    name: "github_pr_review_comments",
    description: "Los comentarios EN LÍNEA de un PR (los que una persona deja sobre una línea del diff), con su id para contestarlos.",
    inputSchema: { type: "object", properties: { ...repoProp, number: { type: "number", description: "Número del PR." } }, required: ["repo", "number"] },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const r = await api(sub, `/repos/${p}/pulls/${Number(a.number)}/comments?per_page=100`);
      if (r?.error) return r;
      return (Array.isArray(r) ? r : []).map((c: any) => ({
        id: c?.id,
        inReplyTo: c?.in_reply_to_id ?? null,
        author: c?.user?.login,
        path: c?.path,
        line: c?.line ?? c?.original_line,
        body: String(c?.body ?? "").slice(0, 2000),
        at: c?.created_at,
      }));
    },
  },
  {
    name: "github_reply_review_comment",
    description: "Contesta un comentario en línea de un PR, en su mismo hilo (usa el `id` de github_pr_review_comments).",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, number: { type: "number", description: "Número del PR." }, comment_id: { type: "number", description: "id del comentario." }, body: str("Respuesta.") },
      required: ["repo", "number", "comment_id", "body"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const w = await writeToken(sub, p);
      if ("error" in w) return w;
      const r = await apiWith(w.token, `/repos/${p}/pulls/${Number(a.number)}/comments/${Number(a.comment_id)}/replies`, {
        method: "POST",
        body: JSON.stringify({ body: String(a.body) }),
      });
      return r?.error ? r : { ok: true, url: r?.html_url };
    },
  },
  {
    name: "github_rerun_workflow",
    description: "Reintenta los jobs FALLIDOS de un workflow run (CI que falló por algo pasajero), sin empujar un commit vacío. El id sale de github_workflow_runs.",
    inputSchema: { type: "object", properties: { ...repoProp, run_id: { type: "number", description: "id del workflow run." } }, required: ["repo", "run_id"] },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const r = await api(sub, `/repos/${p}/actions/runs/${Number(a.run_id)}/rerun-failed-jobs`, { method: "POST" });
      if (r?.error && /Sin permiso/.test(String(r.error))) return missingPermission(p, "Actions: write");
      return r?.error ? r : { ok: true };
    },
  },
  {
    name: "github_dependabot_alerts",
    description: "Avisos de seguridad ABIERTOS de Dependabot del repo (paquete, severidad, versión que lo arregla). Para revisar dependencias con datos reales.",
    inputSchema: { type: "object", properties: { ...repoProp, severity: str("low | medium | high | critical (opcional).") }, required: ["repo"] },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const q = new URLSearchParams({ state: "open", per_page: "50" });
      if (a.severity) q.set("severity", String(a.severity));
      const r = await api(sub, `/repos/${p}/dependabot/alerts?${q}`);
      if (r?.error && /Sin permiso/.test(String(r.error))) return missingPermission(p, "Dependabot alerts: read");
      if (r?.error) return r;
      return (Array.isArray(r) ? r : []).map((x: any) => ({
        number: x?.number,
        package: x?.dependency?.package?.name,
        ecosystem: x?.dependency?.package?.ecosystem,
        severity: x?.security_advisory?.severity,
        summary: x?.security_advisory?.summary,
        fixedIn: x?.security_vulnerability?.first_patched_version?.identifier ?? null,
        url: x?.html_url,
      }));
    },
  },
  {
    name: "github_search",
    description: "Busca issues y PRs de un repo por texto (títulos, cuerpo, comentarios). `type`: issue | pr. Úsala antes de planear para no duplicar trabajo.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, query: str("Qué buscar."), type: str("issue | pr (opcional)"), state: str("open | closed (opcional)") },
      required: ["repo", "query"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const parts = [String(a.query), `repo:${p}`];
      if (a.type === "issue" || a.type === "pr") parts.push(`is:${a.type}`);
      if (a.state === "open" || a.state === "closed") parts.push(`is:${a.state}`);
      const r = await api(sub, `/search/issues?per_page=20&q=${encodeURIComponent(parts.join(" "))}`);
      if (r?.error) return r;
      return (Array.isArray(r?.items) ? r.items : []).map((i: any) => ({
        number: i?.number,
        kind: i?.pull_request ? "pr" : "issue",
        title: i?.title,
        state: i?.state,
        url: i?.html_url,
      }));
    },
  },
  {
    name: "github_update_pr_base",
    description:
      "Cambia la rama DESTINO de un pull request. Es lo que se hace con PRs apilados: cuando se mergea el de abajo, el de arriba se re-apunta a main (y luego github_update_branch).",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        number: { type: "number", description: "Número del PR." },
        base: str("La nueva rama destino."),
      },
      required: ["repo", "number", "base"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const base = String(a.base ?? "").trim();
      if (!base) return { error: "Falta `base`: la rama a la que debe apuntar el PR." };
      const r = await api(sub, `/repos/${p}/pulls/${Number(a.number)}`, {
        method: "PATCH",
        body: JSON.stringify({ base }),
      });
      return r?.error ? r : { ok: true, ...trimPr(r), body: undefined };
    },
  },
  {
    name: "github_workflow_run_logs",
    description:
      "El LOG de un run de GitHub Actions que falló: qué job y qué paso reventaron, y las líneas de error. Es lo que de verdad responde '¿por qué está roja la build?' — github_workflow_runs sólo da el estado. Pásale el `id` que devolvió esa tool. Nunca inventes una línea de log: si esto falla, di que no lo pudiste leer y da la url del run.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        runId: { type: "number", description: "El `id` del run, tal como lo devolvió github_workflow_runs." },
        jobs: { type: "number", description: "Cuántos jobs fallidos traer. 1-5, default 2." },
      },
      required: ["repo", "runId"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const r = await api(sub, `/repos/${p}/actions/runs/${Number(a.runId)}/jobs?per_page=50`);
      if (r?.error) return r;

      const all: any[] = r?.jobs ?? [];
      const failed = all.filter((j) => j?.conclusion === "failure");
      if (!failed.length) {
        // Distinguirlo importa: "no falló" y "falló pero no pude leerlo" llevan a
        // respuestas opuestas, y el modelo tiende a fundirlas en "hubo un error".
        return {
          runId: Number(a.runId),
          failedJobs: 0,
          jobs: all.map((j) => ({ name: j?.name, conclusion: j?.conclusion, url: j?.html_url })),
          note: "Ningún job de este run terminó en failure. Puede seguir corriendo, o el run rojo ser otro.",
        };
      }

      const take = Math.min(Math.max(Number(a.jobs) || 2, 1), 5);
      const out = await Promise.all(
        failed.slice(0, take).map(async (j) => {
          // El paso concreto que reventó suele bastar para el diagnóstico y
          // siempre viene, aunque el log no se pueda bajar.
          const step = (j?.steps ?? []).find((s: any) => s?.conclusion === "failure");
          const raw = await apiText(sub, `/repos/${p}/actions/jobs/${j?.id}/logs`);
          if (typeof raw !== "string") {
            return { job: j?.name, failedStep: step?.name ?? null, url: j?.html_url, ...raw };
          }
          return { job: j?.name, failedStep: step?.name ?? null, url: j?.html_url, ...trimLog(raw) };
        }),
      );
      return {
        runId: Number(a.runId),
        failedJobs: failed.length,
        shown: out.length,
        jobs: out,
      };
    },
  },
  {
    name: "github_comment",
    description:
      "Comenta en un issue o pull request (en GitHub es el mismo hilo). Sale como el bot de Ghosty si la App está instalada en el repo (si no, con el nombre del usuario): confírmalo con él antes, salvo que te lo hayan pedido en el PR.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, number: { type: "number" }, body: str("El comentario, en Markdown.") },
      required: ["repo", "number", "body"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      // Como el bot (como Copilot/CodeRabbit): con la cuenta de la persona, Ghosty le contestaba a
      // su propio @ghosty con su cara (MailMask, 4-oct). Sin App, con la cuenta y constancia.
      const w = await writeToken(sub, p);
      if ("error" in w) return w;
      const r = await apiWith(w.token, `/repos/${p}/issues/${Number(a.number)}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: String(a.body) + (w.bot ? "" : agentTrailer()) }),
      });
      return r?.error ? r : { ok: true, url: r?.html_url };
    },
  },
  {
    name: "github_create_issue",
    description: "Abre un issue nuevo. Confírmalo con el usuario antes.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        title: str("Título."),
        body: str("Descripción en Markdown."),
        labels: { type: "array", items: { type: "string" }, description: "Etiquetas." },
        assignees: { type: "array", items: { type: "string" }, description: "Logins a asignar." },
      },
      required: ["repo", "title"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const r = await api(sub, `/repos/${p}/issues`, {
        method: "POST",
        body: JSON.stringify({
          title: a.title,
          // Un issue lo abre el token del USUARIO (el bot sólo autora ramas y PRs), así que
          // en GitHub es indistinguible de lo que tecleó él. La línea lo deja claro.
          body: String(a.body ?? "") + agentTrailer(),
          labels: a.labels,
          assignees: a.assignees,
        }),
      });
      return r?.error ? r : { ok: true, number: r?.number, url: r?.html_url };
    },
  },
  {
    name: "github_update_issue",
    description: "Cierra, reabre, retitula, re-etiqueta o reasigna un issue. Confírmalo con el usuario antes.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        number: { type: "number" },
        state: str("open | closed."),
        title: str("Nuevo título."),
        labels: { type: "array", items: { type: "string" } },
        assignees: { type: "array", items: { type: "string" } },
      },
      required: ["repo", "number"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const body: Record<string, unknown> = {};
      for (const k of ["state", "title", "labels", "assignees"]) {
        if (a[k] !== undefined) body[k] = a[k];
      }
      if (!Object.keys(body).length) return { error: "Nada que cambiar." };
      const r = await api(sub, `/repos/${p}/issues/${Number(a.number)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      return r?.error ? r : { ok: true, url: r?.html_url };
    },
  },
  {
    name: "github_create_branch",
    description:
      "Crea una rama a partir de otra (default: la principal). Primer paso SIEMPRE antes de escribir código.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, branch: str("Nombre de la rama nueva."), from: str("Rama origen. Default: la principal.") },
      required: ["repo", "branch"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      let from = a.from as string | undefined;
      if (!from) {
        const repo = await api(sub, `/repos/${p}`);
        if (repo?.error) return repo;
        from = repo?.default_branch;
      }
      const ref = await api(sub, `/repos/${p}/git/ref/heads/${encodeURIComponent(String(from))}`);
      if (ref?.error) return ref;
      const w = await writeToken(sub, p);
      if ("error" in w) return w;
      const r = await apiWith(w.token, `/repos/${p}/git/refs`, {
        method: "POST",
        body: JSON.stringify({ ref: `refs/heads/${a.branch}`, sha: ref?.object?.sha }),
      });
      return r?.error ? r : { ok: true, branch: a.branch, from, sha: ref?.object?.sha, asBot: w.bot };
    },
  },
  {
    name: "github_write_file",
    description:
      "Crea o reemplaza un archivo en una rama, con su commit. Texto en `content`; un BINARIO (imagen, PDF) con `fromUrl` o `contentBase64`, nunca en `content` (llegaría corrupto). Para SOBRESCRIBIR uno que ya existe hay que pasar su `sha` (lo devuelve github_read_file) — sin él GitHub rechaza el cambio para no pisar trabajo ajeno. Escribe en una rama de trabajo, nunca en la principal.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        path: str("Ruta del archivo."),
        content: str("Contenido COMPLETO del archivo (no un parche), si es texto."),
        ...binaryProps,
        message: str("Mensaje del commit."),
        branch: str("Rama donde commitear."),
        sha: str("SHA del archivo actual. Obligatorio si el archivo ya existe."),
      },
      required: ["repo", "path", "message", "branch"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const bin = await binaryContent(a);
      if (bin && "error" in bin) return bin;
      if (!bin && typeof a.content !== "string") return { error: "Falta `content` (o `fromUrl`/`contentBase64` para un binario)." };
      const w = await writeToken(sub, p);
      if ("error" in w) return w;
      // Con el bot como autor, el trailer es lo ÚNICO que conserva a la persona en el
      // blame y en su gráfico de contribuciones. Sin él el commit no tiene humano.
      const meta = w.bot ? await readMeta(sub) : null;
      const message = String(a.message) + (meta?.login ? coAuthorTrailer(meta.login) : "");
      const r = await apiWith(w.token, `/repos/${p}/contents/${String(a.path)}`, {
        method: "PUT",
        body: JSON.stringify({
          message,
          content: bin ? bin.b64 : Buffer.from(String(a.content), "utf8").toString("base64"),
          branch: a.branch,
          ...(a.sha ? { sha: a.sha } : {}),
        }),
      });
      return r?.error ? r : { ok: true, commit: r?.commit?.sha, url: r?.content?.html_url, asBot: w.bot };
    },
  },
  {
    name: "github_delete_file",
    description:
      "Borra un archivo en una rama de trabajo, con su commit (nunca en la principal). Úsala cuando el plan pide ELIMINAR archivos: sin ella, un «borra X» no se podía cumplir.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        path: str("Ruta del archivo a borrar."),
        message: str("Mensaje del commit."),
        branch: str("Rama de trabajo donde commitear (no la principal)."),
      },
      required: ["repo", "path", "message", "branch"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const w = await writeToken(sub, p);
      if ("error" in w) return w;
      const branch = String(a.branch ?? "").trim();
      if (!branch) return { error: "Falta la rama." };
      // Borrar en la principal se salta el PR y la revisión: nunca.
      const info = await apiWith(w.token, `/repos/${p}`);
      if (branch === String(info?.default_branch ?? "main")) return { error: "No se borra en la rama principal: hazlo en tu rama de trabajo y entra por PR." };
      const path = String(a.path).replace(/^\/+/, "");
      const cur = await apiWith(w.token, `/repos/${p}/contents/${path}?ref=${encodeURIComponent(branch)}`);
      if (cur?.error) return { error: `No encuentro ${path} en ${branch}: ${cur.error}` };
      if (Array.isArray(cur)) return { error: `${path} es una carpeta: borra sus archivos uno por uno.` };
      const meta = w.bot ? await readMeta(sub) : null;
      const message = String(a.message) + (meta?.login ? coAuthorTrailer(meta.login) : "");
      const r = await apiWith(w.token, `/repos/${p}/contents/${path}`, {
        method: "DELETE",
        body: JSON.stringify({ message, sha: cur?.sha, branch }),
      });
      return r?.error ? r : { ok: true, deleted: path, commit: r?.commit?.sha, asBot: w.bot };
    },
  },
  {
    name: "github_create_pr",
    description: "Abre un pull request de una rama hacia otra. Confírmalo con el usuario antes.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        title: str("Título del PR."),
        head: str("Rama con los cambios."),
        base: str("Rama destino. Default: la principal."),
        body: str("Descripción en Markdown."),
        draft: { type: "boolean", description: "Abrirlo como borrador." },
      },
      required: ["repo", "title", "head"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      let base = a.base as string | undefined;
      if (!base) {
        const repo = await api(sub, `/repos/${p}`);
        if (repo?.error) return repo;
        base = repo?.default_branch;
      }
      const w = await writeToken(sub, p);
      if ("error" in w) return w;
      // El autor del PR pasa a ser el bot, así que "quién pidió esto" deja de leerse en
      // la cabecera de GitHub y tiene que decirlo el cuerpo.
      const who = w.bot ? await readMeta(sub) : null;
      const body = String(a.body ?? "") + (who?.login ? `\n\n---\nAbierto por Ghosty a petición de @${who.login}.` : "");
      const r = await apiWith(w.token, `/repos/${p}/pulls`, {
        method: "POST",
        body: JSON.stringify({ title: a.title, head: a.head, base, body, draft: a.draft === true }),
      });
      return r?.error
        ? r
        : {
            ok: true,
            number: r?.number,
            url: r?.html_url,
            asBot: w.bot,
            // Se lo decimos al MODELO para que avise: si el PR salió a nombre del usuario,
            // esa persona no va a poder aprobarlo.
            nota: w.bot
              ? "El PR lo abrió ghosty[bot], así que cualquiera del equipo puede aprobarlo."
              : "El PR salió a nombre del usuario: GitHub NO le va a dejar aprobar su propio PR. Que lo apruebe otra persona.",
          };
    },
  },  // ── Segundo lote de paridad con el MCP oficial (25-oct): repos, releases, etiquetas,
  // Actions, seguridad, búsqueda, sub-issues, discussions, gists y rulesets. El contraste
  // vive en ghosty-studio/docs/claude/github-tools-vs-oficial.md.
  {
    name: "github_delete_repo",
    description:
      "BORRA un repositorio para siempre (código, issues, PRs, releases). Sólo repos de la persona o de una organización donde es admin. " +
      "Antes de llamarla confirma con la persona NOMBRANDO el repo («¿borro dueño/repo? no se puede deshacer») y pasa `confirmado: true` sólo si dijo que sí.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, confirmado: { type: "boolean", description: "Obligatorio en true: la persona confirmó el borrado nombrando el repo." } },
      required: ["repo", "confirmado"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const full = decodeURIComponent(p);
      if (a.confirmado !== true) {
        return { error: `Borrar ${full} no se puede deshacer. Pregúntale a la persona «¿borro ${full}?» y vuelve a llamar con confirmado: true sólo si dice que sí.` };
      }
      const login = (await readMeta(sub))?.login ?? "";
      const repo = await api(sub, `/repos/${p}`);
      if (repo?.error) return repo;
      const owner = String(repo?.owner?.login ?? "");
      let suyo = !!login && owner.toLowerCase() === login.toLowerCase();
      if (!suyo && repo?.owner?.type === "Organization") {
        const m = await api(sub, `/user/memberships/orgs/${encodeURIComponent(owner)}`);
        suyo = m?.state === "active" && m?.role === "admin";
      }
      if (!suyo) {
        return { error: `Sólo borro repos de @${login || "la persona"} o de una organización donde es admin. ${full} es de ${owner}: que lo borre su dueño.` };
      }
      const r = await api(sub, `/repos/${p}`, { method: "DELETE" });
      if (r?.error && /Sin permiso/.test(String(r.error))) return missingPermission(p, "Administration: write");
      return r?.error ? r : { ok: true, deleted: repo?.full_name ?? full };
    },
  },
  {
    name: "github_fork_repo",
    description: "Hace un fork de un repo a la cuenta de la persona (o a una de sus organizaciones con `org`). GitHub lo crea en segundo plano: puede tardar unos segundos en tener contenido.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        org: str("Opcional: organización destino. Sin ella, la cuenta personal."),
        name: str("Opcional: nombre del fork (default el mismo)."),
        defaultBranchOnly: { type: "boolean", description: "Sólo la rama principal (default false)." },
      },
      required: ["repo"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const body: Record<string, unknown> = {};
      if (a.org) body.organization = String(a.org).trim();
      if (a.name) body.name = String(a.name).trim();
      if (a.defaultBranchOnly === true) body.default_branch_only = true;
      const r = await api(sub, `/repos/${p}/forks`, { method: "POST", body: JSON.stringify(body) });
      if (r?.error) return r;
      return {
        repo: r?.full_name,
        url: r?.html_url,
        defaultBranch: r?.default_branch,
        private: r?.private,
        nota: `Si la app de Ghosty está con «Only select repositories», el fork no entra solo: que lo marque en ${MANAGE_URL} para que las demás tools lo alcancen.`,
      };
    },
  },
  {
    name: "github_list_branches",
    description: "Las ramas de un repo (hasta 100), con su último commit y si están protegidas.",
    inputSchema: { type: "object", properties: { ...repoProp, protected: { type: "boolean", description: "Sólo las protegidas." } }, required: ["repo"] },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const r = await api(sub, `/repos/${p}/branches?per_page=100${a.protected === true ? "&protected=true" : ""}`);
      if (r?.error) return r;
      return (Array.isArray(r) ? r : []).map((b: any) => ({ name: b?.name, sha: String(b?.commit?.sha ?? "").slice(0, 12), protected: !!b?.protected }));
    },
  },
  {
    name: "github_list_collaborators",
    description: "Quién tiene acceso al repo y con qué rol (read, triage, write, maintain, admin). Requiere que la persona tenga push en el repo.",
    inputSchema: { type: "object", properties: { ...repoProp, affiliation: str("outside | direct | all. Default all.") }, required: ["repo"] },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const r = await api(sub, `/repos/${p}/collaborators` + qs({ affiliation: a.affiliation, per_page: 100 }, ["affiliation", "per_page"]));
      if (r?.error) return r;
      return (Array.isArray(r) ? r : []).map((c: any) => ({ login: c?.login, role: c?.role_name ?? null, admin: !!c?.permissions?.admin }));
    },
  },
  {
    name: "github_list_releases",
    description: "Releases del repo, de la más reciente hacia atrás (incluye borradores si la persona puede verlos).",
    inputSchema: { type: "object", properties: { ...repoProp, limit: { type: "number", description: "1-100, default 10." } }, required: ["repo"] },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const r = await api(sub, `/repos/${p}/releases?per_page=${Math.min(Math.max(Number(a.limit) || 10, 1), 100)}`);
      if (r?.error) return r;
      return (Array.isArray(r) ? r : []).map((x: any) => ({ ...trimRelease(x), body: undefined }));
    },
  },
  {
    name: "github_get_release",
    description: "Una release con sus notas y archivos adjuntos: la última publicada (sin `tag`) o la de un tag concreto.",
    inputSchema: { type: "object", properties: { ...repoProp, tag: str("Tag de la release (p. ej. v1.2.0). Sin él, la última publicada.") }, required: ["repo"] },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const tag = String(a.tag ?? "").trim();
      const r = await api(sub, tag ? `/repos/${p}/releases/tags/${encodeURIComponent(tag)}` : `/repos/${p}/releases/latest`);
      return r?.error ? r : trimRelease(r);
    },
  },
  {
    name: "github_create_release",
    description:
      "Publica una release sobre un tag (si el tag no existe, GitHub lo crea en `target`). Con `generateNotes` GitHub escribe las notas a partir de los PRs. " +
      "Una release publicada avisa a quien sigue el repo: confírmalo con la persona antes, o créala como borrador (`draft: true`).",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        tag: str("Tag, p. ej. v1.2.0."),
        name: str("Título (default el tag)."),
        body: str("Notas en Markdown."),
        target: str("Rama o SHA donde crear el tag si no existe. Default: la principal."),
        draft: { type: "boolean", description: "Borrador (no se publica ni avisa)." },
        prerelease: { type: "boolean", description: "Marcar como pre-release." },
        generateNotes: { type: "boolean", description: "Que GitHub genere las notas." },
      },
      required: ["repo", "tag"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const tag = String(a.tag ?? "").trim();
      if (!tag) return { error: "Falta `tag`." };
      const body: Record<string, unknown> = { tag_name: tag, draft: a.draft === true, prerelease: a.prerelease === true, generate_release_notes: a.generateNotes === true };
      if (a.name) body.name = String(a.name);
      if (typeof a.body === "string") body.body = a.body;
      if (a.target) body.target_commitish = String(a.target);
      const w = await writeToken(sub, p);
      if ("error" in w) return w;
      const r = await apiWith(w.token, `/repos/${p}/releases`, { method: "POST", body: JSON.stringify(body) });
      if (denied(r)) return missingPermission(p, "Contents: write");
      return r?.error ? r : { ok: true, ...trimRelease(r), body: undefined, asBot: w.bot };
    },
  },
  {
    name: "github_list_tags",
    description: "Tags del repo (hasta 100), del más reciente hacia atrás, con el commit al que apuntan.",
    inputSchema: { type: "object", properties: { ...repoProp }, required: ["repo"] },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const r = await api(sub, `/repos/${p}/tags?per_page=100`);
      if (r?.error) return r;
      return (Array.isArray(r) ? r : []).map((t: any) => ({ tag: t?.name, sha: String(t?.commit?.sha ?? "").slice(0, 12) }));
    },
  },
  {
    name: "github_get_tag",
    description: "Detalle de un tag: a qué commit apunta y, si es anotado, su mensaje y quién lo creó.",
    inputSchema: { type: "object", properties: { ...repoProp, tag: str("Nombre del tag.") }, required: ["repo", "tag"] },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const tag = String(a.tag ?? "").trim();
      const ref = await api(sub, `/repos/${p}/git/ref/tags/${encodeURIComponent(tag)}`);
      if (ref?.error) return ref;
      if (ref?.object?.type !== "tag") return { tag, annotated: false, commit: ref?.object?.sha };
      const t = await api(sub, `/repos/${p}/git/tags/${ref.object.sha}`);
      if (t?.error) return t;
      return { tag, annotated: true, commit: t?.object?.sha, message: t?.message, tagger: t?.tagger?.name, date: t?.tagger?.date };
    },
  },
  {
    name: "github_list_labels",
    description: "Las etiquetas del repo (nombre, color, descripción). Úsala antes de etiquetar para no inventar una que no existe.",
    inputSchema: { type: "object", properties: { ...repoProp }, required: ["repo"] },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const r = await api(sub, `/repos/${p}/labels?per_page=100`);
      if (r?.error) return r;
      return (Array.isArray(r) ? r : []).map(trimLabel);
    },
  },
  {
    name: "github_get_label",
    description: "Una etiqueta del repo por nombre.",
    inputSchema: { type: "object", properties: { ...repoProp, name: str("Nombre de la etiqueta.") }, required: ["repo", "name"] },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const r = await api(sub, `/repos/${p}/labels/${encodeURIComponent(String(a.name ?? ""))}`);
      return r?.error ? r : trimLabel(r);
    },
  },
  {
    name: "github_label_write",
    description:
      "Crea, edita o borra una etiqueta del REPO (no de un issue: para etiquetar un issue usa github_update_issue). " +
      "Borrarla la quita de todos los issues y PRs que la tengan: confírmalo con la persona antes.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        action: str("create | update | delete."),
        name: str("Nombre de la etiqueta (la actual, al editar o borrar)."),
        newName: str("Al editar: nombre nuevo."),
        color: str("Hex sin # (p. ej. d73a4a)."),
        description: str("Descripción corta."),
      },
      required: ["repo", "action", "name"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const name = String(a.name ?? "").trim();
      if (!name) return { error: "Falta `name`." };
      const color = typeof a.color === "string" ? a.color.replace(/^#/, "").trim() : undefined;
      if (color && !/^[0-9a-f]{6}$/i.test(color)) return { error: "`color` va en hex de 6 dígitos, sin #." };
      const w = await writeToken(sub, p);
      if ("error" in w) return w;
      let r: any;
      if (a.action === "create") {
        r = await apiWith(w.token, `/repos/${p}/labels`, { method: "POST", body: JSON.stringify({ name, color: color ?? "ededed", description: a.description }) });
      } else if (a.action === "update") {
        const patch: Record<string, unknown> = {};
        if (a.newName) patch.new_name = String(a.newName).trim();
        if (color) patch.color = color;
        if (typeof a.description === "string") patch.description = a.description;
        if (!Object.keys(patch).length) return { error: "Pasa newName, color o description." };
        r = await apiWith(w.token, `/repos/${p}/labels/${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify(patch) });
      } else if (a.action === "delete") {
        r = await apiWith(w.token, `/repos/${p}/labels/${encodeURIComponent(name)}`, { method: "DELETE" });
        return denied(r) ? missingPermission(p, "Issues: write") : r?.error ? r : { ok: true, deleted: name };
      } else {
        return { error: "`action` va como create, update o delete." };
      }
      if (denied(r)) return missingPermission(p, "Issues: write");
      return r?.error ? r : { ok: true, ...trimLabel(r) };
    },
  },
  {
    name: "github_list_workflows",
    description: "Los workflows de GitHub Actions del repo (id, nombre, archivo, si están activos). El id o el archivo es lo que pide github_run_workflow.",
    inputSchema: { type: "object", properties: { ...repoProp }, required: ["repo"] },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const r = await api(sub, `/repos/${p}/actions/workflows?per_page=100`);
      if (r?.error) return r;
      return (r?.workflows ?? []).map((x: any) => ({ id: x?.id, name: x?.name, file: String(x?.path ?? "").split("/").pop(), state: x?.state }));
    },
  },
  {
    name: "github_get_workflow_run",
    description: "Un run de Actions con sus jobs: estado, conclusión y el paso que falló en cada uno. Para el log completo usa github_workflow_run_logs.",
    inputSchema: { type: "object", properties: { ...repoProp, run_id: { type: "number", description: "id del workflow run." } }, required: ["repo", "run_id"] },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const id = Number(a.run_id);
      const [run, jobs] = await Promise.all([api(sub, `/repos/${p}/actions/runs/${id}`), api(sub, `/repos/${p}/actions/runs/${id}/jobs?per_page=50`)]);
      if (run?.error) return run;
      return {
        id: run?.id,
        name: run?.name,
        branch: run?.head_branch,
        sha: String(run?.head_sha ?? "").slice(0, 12),
        event: run?.event,
        status: run?.status,
        conclusion: run?.conclusion,
        attempt: run?.run_attempt,
        at: run?.created_at,
        url: run?.html_url,
        jobs: (jobs?.jobs ?? []).map((j: any) => ({
          name: j?.name,
          status: j?.status,
          conclusion: j?.conclusion,
          failedStep: (j?.steps ?? []).find((s: any) => s?.conclusion === "failure")?.name ?? null,
        })),
      };
    },
  },
  {
    name: "github_run_workflow",
    description:
      "Lanza a mano un workflow de Actions que acepte `workflow_dispatch` (deploys, tareas programadas, scripts). `workflow` es el id o el nombre del archivo (deploy.yml) de github_list_workflows. " +
      "Un workflow puede desplegar o tocar producción: confírmalo con la persona antes. GitHub no devuelve el run: búscalo después con github_workflow_runs.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        workflow: str("id o archivo del workflow (p. ej. deploy.yml)."),
        ref: str("Rama o tag donde correrlo. Default: la principal."),
        inputs: { type: "object", description: "Inputs del workflow como { nombre: valor } (texto)." },
      },
      required: ["repo", "workflow"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const wf = String(a.workflow ?? "").trim().split("/").pop() ?? "";
      if (!wf) return { error: "Falta `workflow`: el id o el archivo (deploy.yml)." };
      let ref = String(a.ref ?? "").trim();
      if (!ref) {
        const repo = await api(sub, `/repos/${p}`);
        if (repo?.error) return repo;
        ref = repo?.default_branch;
      }
      const inputs: Record<string, string> = {};
      if (a.inputs && typeof a.inputs === "object") for (const [k, v] of Object.entries(a.inputs)) inputs[k] = typeof v === "string" ? v : JSON.stringify(v);
      const w = await writeToken(sub, p);
      if ("error" in w) return w;
      const r = await apiWith(w.token, `/repos/${p}/actions/workflows/${encodeURIComponent(wf)}/dispatches`, { method: "POST", body: JSON.stringify({ ref, inputs }) });
      if (denied(r)) return missingPermission(p, "Actions: write");
      if (r?.error && /\b422\b/.test(String(r.error))) return { error: `${r.error} Lo usual: el workflow no tiene \`on: workflow_dispatch\` en esa rama, o le falta un input obligatorio.` };
      return r?.error ? r : { ok: true, workflow: wf, ref, nota: "Lanzado. Búscalo en unos segundos con github_workflow_runs." };
    },
  },
  {
    name: "github_cancel_workflow_run",
    description: "Cancela un run de Actions que sigue en cola o corriendo. El id sale de github_workflow_runs.",
    inputSchema: { type: "object", properties: { ...repoProp, run_id: { type: "number", description: "id del workflow run." } }, required: ["repo", "run_id"] },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const w = await writeToken(sub, p);
      if ("error" in w) return w;
      const r = await apiWith(w.token, `/repos/${p}/actions/runs/${Number(a.run_id)}/cancel`, { method: "POST" });
      if (denied(r)) return missingPermission(p, "Actions: write");
      if (r?.error && /\b409\b/.test(String(r.error))) return { error: "Ese run ya terminó: no hay nada que cancelar." };
      return r?.error ? r : { ok: true };
    },
  },
  {
    name: "github_code_scanning_alerts",
    description: "Avisos de code scanning (CodeQL u otra herramienta) del repo: regla, severidad, archivo y línea. Sin `number`, la lista de abiertos; con `number`, el detalle de uno.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, number: { type: "number", description: "Opcional: un aviso concreto." }, severity: str("critical | high | medium | low | warning | note | error (opcional).") },
      required: ["repo"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const one = Number(a.number) > 0;
      const r = await api(
        sub,
        one ? `/repos/${p}/code-scanning/alerts/${Number(a.number)}` : `/repos/${p}/code-scanning/alerts` + qs({ state: "open", severity: a.severity, per_page: 50 }, ["state", "severity", "per_page"]),
      );
      if (r?.error && /Sin permiso/.test(String(r.error))) return missingPermission(p, "Code scanning alerts: read");
      if (r?.error) return r;
      const trim = (x: any) => ({
        number: x?.number,
        state: x?.state,
        rule: x?.rule?.id,
        summary: x?.rule?.description,
        severity: x?.rule?.security_severity_level ?? x?.rule?.severity,
        tool: x?.tool?.name,
        path: x?.most_recent_instance?.location?.path,
        line: x?.most_recent_instance?.location?.start_line,
        url: x?.html_url,
      });
      if (one) return { ...trim(r), message: r?.most_recent_instance?.message?.text, help: typeof r?.rule?.help === "string" ? r.rule.help.slice(0, 3000) : null };
      return (Array.isArray(r) ? r : []).map(trim);
    },
  },
  {
    name: "github_secret_scanning_alerts",
    description:
      "Avisos de secret scanning del repo: qué tipo de secreto se filtró, dónde y si sigue vigente. NUNCA devuelve el secreto en sí. " +
      "Sin `number`, la lista de abiertos; con `number`, el detalle con archivo y línea.",
    inputSchema: { type: "object", properties: { ...repoProp, number: { type: "number", description: "Opcional: un aviso concreto." } }, required: ["repo"] },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const one = Number(a.number) > 0;
      // `hide_secret` además de no copiar el campo: el valor filtrado no entra ni al proceso.
      const r = await api(sub, one ? `/repos/${p}/secret-scanning/alerts/${Number(a.number)}?hide_secret=true` : `/repos/${p}/secret-scanning/alerts?state=open&per_page=50&hide_secret=true`);
      if (r?.error && /Sin permiso/.test(String(r.error))) return missingPermission(p, "Secret scanning alerts: read");
      if (r?.error) return r;
      const trim = (x: any) => ({
        number: x?.number,
        state: x?.state,
        secretType: x?.secret_type_display_name ?? x?.secret_type,
        validity: x?.validity ?? null,
        publiclyLeaked: x?.publicly_leaked ?? null,
        createdAt: x?.created_at,
        url: x?.html_url,
      });
      if (!one) return (Array.isArray(r) ? r : []).map(trim);
      const loc = await api(sub, `/repos/${p}/secret-scanning/alerts/${Number(a.number)}/locations?per_page=20`);
      return {
        ...trim(r),
        locations: (Array.isArray(loc) ? loc : []).map((l: any) => ({ type: l?.type, path: l?.details?.path ?? null, line: l?.details?.start_line ?? null, commit: String(l?.details?.commit_sha ?? "").slice(0, 12) || null })),
      };
    },
  },
  {
    name: "github_get_me",
    description: "Quién es la persona en GitHub: su login, nombre y en qué cuentas está instalada la app de Ghosty.",
    inputSchema: { type: "object", properties: {} },
    handler: async (sub) => {
      const [me, inst] = await Promise.all([api(sub, "/user"), api(sub, "/user/installations")]);
      if (me?.error) return me;
      return {
        login: me?.login,
        name: me?.name,
        company: me?.company,
        bio: me?.bio,
        publicRepos: me?.public_repos,
        url: me?.html_url,
        installedOn: ((inst?.installations ?? []) as any[]).map((i) => ({ account: i?.account?.login, allRepos: i?.repository_selection === "all" })),
      };
    },
  },
  {
    name: "github_search_repos",
    description:
      "Busca repositorios en GitHub con la sintaxis de búsqueda (p. ej. «react router language:typescript stars:>100», «user:blissito»). Sólo en un chat directo con la persona: en un room los resultados (incluidos privados) los verían otros.",
    inputSchema: { type: "object", properties: { query: str("Qué buscar."), limit: { type: "number", description: "1-50, default 20." } }, required: ["query"] },
    handler: async (sub, a) => {
      const q = String(a.query ?? "").trim();
      if (!q) return { error: "Falta `query`." };
      const r = await api(sub, `/search/repositories?q=${encodeURIComponent(q)}&per_page=${Math.min(Math.max(Number(a.limit) || 20, 1), 50)}`);
      if (r?.error) return r;
      return {
        total: r?.total_count,
        repos: (r?.items ?? []).map((x: any) => ({ repo: x?.full_name, description: x?.description, private: x?.private, stars: x?.stargazers_count, language: x?.language, pushedAt: x?.pushed_at, url: x?.html_url })),
      };
    },
  },
  {
    name: "github_search_users",
    description: "Busca personas u organizaciones en GitHub (p. ej. «tom location:mexico», «type:org fixter»).",
    inputSchema: { type: "object", properties: { query: str("Qué buscar."), limit: { type: "number", description: "1-50, default 20." } }, required: ["query"] },
    handler: async (sub, a) => {
      const q = String(a.query ?? "").trim();
      if (!q) return { error: "Falta `query`." };
      const r = await api(sub, `/search/users?q=${encodeURIComponent(q)}&per_page=${Math.min(Math.max(Number(a.limit) || 20, 1), 50)}`);
      if (r?.error) return r;
      return { total: r?.total_count, users: (r?.items ?? []).map((u: any) => ({ login: u?.login, type: u?.type, url: u?.html_url })) };
    },
  },
  {
    name: "github_list_sub_issues",
    description: "Los sub-issues de un issue (la lista de tareas hijas que GitHub muestra debajo).",
    inputSchema: { type: "object", properties: { ...repoProp, number: { type: "number", description: "Número del issue padre." } }, required: ["repo", "number"] },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const r = await api(sub, `/repos/${p}/issues/${Number(a.number)}/sub_issues?per_page=100`);
      if (r?.error) return r;
      return (Array.isArray(r) ? r : []).map((i: any) => ({ number: i?.number, title: i?.title, state: i?.state, assignees: (i?.assignees ?? []).map((x: any) => x?.login), url: i?.html_url }));
    },
  },
  {
    name: "github_sub_issue_write",
    description:
      "Arma la jerarquía de issues: `add` cuelga un issue como sub-issue de otro, `remove` lo desprende (no lo cierra) y `reprioritize` lo mueve de lugar en la lista (con `after` o `before`). Ambos issues del mismo repo.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        number: { type: "number", description: "Número del issue padre." },
        action: str("add | remove | reprioritize."),
        sub: { type: "number", description: "Número del issue hijo." },
        after: { type: "number", description: "reprioritize: dejarlo después de este sub-issue (número)." },
        before: { type: "number", description: "reprioritize: dejarlo antes de este sub-issue (número)." },
        replaceParent: { type: "boolean", description: "add: si ya tiene otro padre, cambiarlo a este." },
      },
      required: ["repo", "number", "action", "sub"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      // La API pide el ID interno del issue, no su número: se resuelve aquí para que el modelo
      // sólo maneje los números que ve.
      const idOf = async (n: unknown): Promise<number | { error: string }> => {
        const i = await api(sub, `/repos/${p}/issues/${Number(n)}`);
        return typeof i?.id === "number" ? i.id : { error: i?.error ?? `No encontré el issue #${n}.` };
      };
      const child = await idOf(a.sub);
      if (typeof child !== "number") return child;
      const base = `/repos/${p}/issues/${Number(a.number)}`;
      let path: string;
      let method: string;
      const body: Record<string, unknown> = { sub_issue_id: child };
      if (a.action === "add") {
        [path, method] = [`${base}/sub_issues`, "POST"];
        if (a.replaceParent === true) body.replace_parent = true;
      } else if (a.action === "remove") {
        [path, method] = [`${base}/sub_issue`, "DELETE"];
      } else if (a.action === "reprioritize") {
        [path, method] = [`${base}/sub_issues/priority`, "PATCH"];
        const anchor = a.after ?? a.before;
        if (anchor === undefined) return { error: "Pasa `after` o `before`." };
        const id = await idOf(anchor);
        if (typeof id !== "number") return id;
        body[a.after !== undefined ? "after_id" : "before_id"] = id;
      } else {
        return { error: "`action` va como add, remove o reprioritize." };
      }
      const w = await writeToken(sub, p);
      if ("error" in w) return w;
      const r = await apiWith(w.token, path, { method, body: JSON.stringify(body) });
      if (denied(r)) return missingPermission(p, "Issues: write");
      return r?.error ? r : { ok: true, parent: Number(a.number), sub: Number(a.sub), action: a.action };
    },
  },
  {
    name: "github_list_issue_types",
    description: "Los tipos de issue (Bug, Feature, Task…) que define la organización dueña del repo. Sólo existen en organizaciones, no en cuentas personales.",
    inputSchema: { type: "object", properties: { ...repoProp }, required: ["repo"] },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const owner = p.split("/")[0];
      const r = await api(sub, `/orgs/${owner}/issue-types`);
      if (r?.error && /Sin permiso/.test(String(r.error))) return missingPermission(p, "Issue types: read (organización)");
      if (r?.error) return { error: `${r.error} Ojo: los tipos de issue sólo existen en organizaciones; si ${decodeURIComponent(owner)} es una cuenta personal, no hay.` };
      return (Array.isArray(r) ? r : []).map((t: any) => ({ id: t?.id, name: t?.name, description: t?.description, color: t?.color }));
    },
  },
  {
    name: "github_list_discussions",
    description: "Las discussions del repo (foro de GitHub), de la más reciente hacia atrás: título, categoría, autor, respuestas y si ya tiene respuesta elegida.",
    inputSchema: { type: "object", properties: { ...repoProp, limit: { type: "number", description: "1-50, default 20." } }, required: ["repo"] },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const [owner, name] = decodeURIComponent(p).split("/");
      const d = await graphql(
        sub,
        `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){discussions(first:$n,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title author{login} category{name} createdAt updatedAt url isAnswered comments{totalCount}}}}}`,
        { owner, name, n: Math.min(Math.max(Number(a.limit) || 20, 1), 50) },
      );
      if (d?.error) return /not accessible/i.test(String(d.error)) ? missingPermission(p, "Discussions: read") : d;
      return (d?.repository?.discussions?.nodes ?? []).map((x: any) => ({
        number: x?.number, title: x?.title, category: x?.category?.name, author: x?.author?.login ?? null,
        comments: x?.comments?.totalCount, answered: !!x?.isAnswered, updatedAt: x?.updatedAt, url: x?.url,
      }));
    },
  },
  {
    name: "github_get_discussion",
    description: "Una discussion con su texto y sus comentarios (hasta 50), marcando cuál es la respuesta elegida.",
    inputSchema: { type: "object", properties: { ...repoProp, number: { type: "number", description: "Número de la discussion." } }, required: ["repo", "number"] },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const [owner, name] = decodeURIComponent(p).split("/");
      const d = await graphql(
        sub,
        `query($owner:String!,$name:String!,$num:Int!){repository(owner:$owner,name:$name){discussion(number:$num){number title body author{login} category{name} createdAt url comments(first:50){nodes{author{login} body createdAt isAnswer}}}}}`,
        { owner, name, num: Number(a.number) },
      );
      if (d?.error) return /not accessible/i.test(String(d.error)) ? missingPermission(p, "Discussions: read") : d;
      const x = d?.repository?.discussion;
      if (!x) return { error: `No encontré la discussion #${a.number}.` };
      return {
        number: x.number, title: x.title, category: x.category?.name, author: x.author?.login ?? null, createdAt: x.createdAt, url: x.url,
        body: String(x.body ?? "").slice(0, 6000),
        comments: (x.comments?.nodes ?? []).map((c: any) => ({ author: c?.author?.login ?? null, at: c?.createdAt, answer: !!c?.isAnswer, body: String(c?.body ?? "").slice(0, 2000) })),
      };
    },
  },
  {
    name: "github_list_gists",
    description: "Los gists de la persona (públicos y secretos), del más reciente hacia atrás. Sólo en un chat directo con ella.",
    inputSchema: { type: "object", properties: { limit: { type: "number", description: "1-100, default 30." } } },
    handler: async (sub, a) => {
      const r = await api(sub, `/gists?per_page=${Math.min(Math.max(Number(a.limit) || 30, 1), 100)}`);
      if (r?.error) return gistError(r);
      return (Array.isArray(r) ? r : []).map((g: any) => ({ id: g?.id, description: g?.description, public: g?.public, files: Object.keys(g?.files ?? {}), updatedAt: g?.updated_at, url: g?.html_url }));
    },
  },
  {
    name: "github_get_gist",
    description: "Un gist con el contenido de sus archivos. Sólo en un chat directo con la persona.",
    inputSchema: { type: "object", properties: { id: str("id del gist (o su URL).") }, required: ["id"] },
    handler: async (sub, a) => {
      const id = String(a.id ?? "").trim().split("/").pop() ?? "";
      if (!/^[0-9a-f]{5,}$/i.test(id)) return { error: "`id` no parece un id de gist." };
      const r = await api(sub, `/gists/${id}`);
      if (r?.error) return gistError(r);
      return {
        id: r?.id, description: r?.description, public: r?.public, owner: r?.owner?.login, url: r?.html_url,
        files: Object.values(r?.files ?? {}).map((f: any) => ({ name: f?.filename, language: f?.language, truncated: !!f?.truncated || String(f?.content ?? "").length > 20000, content: String(f?.content ?? "").slice(0, 20000) })),
      };
    },
  },
  {
    name: "github_create_gist",
    description: "Crea un gist con uno o más archivos. Nace SECRETO (sólo con la liga) salvo `public: true`; uno público lo ve cualquiera, confírmalo con la persona. Sólo en un chat directo con ella.",
    inputSchema: {
      type: "object",
      properties: {
        description: str("Descripción corta."),
        public: { type: "boolean", description: "Público (default false)." },
        files: { type: "array", items: { type: "object", properties: { name: str("Nombre del archivo."), content: str("Contenido.") }, required: ["name", "content"] } },
      },
      required: ["files"],
    },
    handler: async (sub, a) => {
      const list = Array.isArray(a.files) ? (a.files as any[]) : [];
      const files: Record<string, { content: string }> = {};
      for (const f of list) {
        const name = String(f?.name ?? "").trim();
        if (!name || typeof f?.content !== "string" || !f.content) return { error: "Cada archivo lleva `name` y `content` (no vacío)." };
        files[name] = { content: f.content };
      }
      if (!Object.keys(files).length) return { error: "Pasa al menos un archivo en `files`." };
      const r = await api(sub, "/gists", { method: "POST", body: JSON.stringify({ description: a.description, public: a.public === true, files }) });
      if (r?.error) return gistError(r);
      return { ok: true, id: r?.id, public: r?.public, url: r?.html_url };
    },
  },
  {
    name: "github_list_rulesets",
    description: "Los rulesets del repo (y los heredados de la organización): reglas que protegen ramas y tags. Con `branch`, en cambio, las reglas que se le aplican HOY a esa rama.",
    inputSchema: { type: "object", properties: { ...repoProp, branch: str("Opcional: rama concreta.") }, required: ["repo"] },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const branch = String(a.branch ?? "").trim();
      if (branch) {
        const r = await api(sub, `/repos/${p}/rules/branches/${encodeURIComponent(branch)}?per_page=100`);
        if (r?.error) return r;
        return { branch, rules: (Array.isArray(r) ? r : []).map((x: any) => ({ type: x?.type, rulesetId: x?.ruleset_id, parameters: x?.parameters ?? null })) };
      }
      const r = await api(sub, `/repos/${p}/rulesets?includes_parents=true&per_page=100`);
      if (r?.error && /Sin permiso/.test(String(r.error))) return missingPermission(p, "Administration: read");
      if (r?.error) return r;
      return (Array.isArray(r) ? r : []).map((x: any) => ({ id: x?.id, name: x?.name, target: x?.target, enforcement: x?.enforcement, source: x?.source }));
    },
  },
  {
    name: "github_get_ruleset",
    description: "Un ruleset completo: a qué ramas o tags aplica, sus reglas y quién puede saltárselas. El id sale de github_list_rulesets.",
    inputSchema: { type: "object", properties: { ...repoProp, id: { type: "number", description: "id del ruleset." } }, required: ["repo", "id"] },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const r = await api(sub, `/repos/${p}/rulesets/${Number(a.id)}`);
      if (r?.error && /Sin permiso/.test(String(r.error))) return missingPermission(p, "Administration: read");
      if (r?.error) return r;
      return {
        id: r?.id, name: r?.name, target: r?.target, enforcement: r?.enforcement, source: r?.source,
        conditions: r?.conditions ?? null,
        rules: (r?.rules ?? []).map((x: any) => ({ type: x?.type, parameters: x?.parameters ?? null })),
        bypass: (r?.bypass_actors ?? []).map((b: any) => ({ type: b?.actor_type, id: b?.actor_id, mode: b?.bypass_mode })),
      };
    },
  },
];

/**
 * El set de tools depende de DÓNDE ocurre el turno. Mismo criterio que las alertas de Sentry
 * (`sentry.server.ts`), pero aquí la razón es más fuerte que ahorrar contexto: es la
 * frontera.
 *
 * - **DM 1:1** → todo. Es su conexión, su privacidad, y nadie más lee la respuesta.
 * - **Room CON repos** → todo, acotado a esos repos por el candado de `runTool`.
 * - **Room SIN repos** → NADA. Sin vínculo no hay acceso, que es el modelo de hilos y del
 *   /github subscribe de Slack. `ambientContext` explica por qué y a dónde ir.
 *
 * ⚠️ Esto es la capa de UX: filtrar lo que se le OFRECE al modelo. El candado de verdad vive
 * en `runTool` (tools.server.ts), porque el modelo puede inventar un repo en los argumentos
 * de una tool que sí se le ofreció.
 */
/**
 * Todas las tools SIN el filtro del room. Es para la UI del picker, que corre con el token
 * de quien hace clic y no dentro de un turno del agente — ahí la frontera la pone la sesión
 * de la persona, no el alcance del room (justamente está eligiendo qué atarle).
 *
 * ⚠️ No la use nada que corra en nombre del modelo. Para eso está `tools(sub, dest)`.
 */
export function allTools(): ConnectorTool[] {
  return [...ALL_TOOLS, watchTool(null)];
}

export async function tools(_sub: string, dest: ToolDest | null): Promise<ConnectorTool[]> {
  const allowed = await allowedRepos(dest);
  if (allowed && !allowed.length) return [];
  const base = allowed ? ALL_TOOLS.filter((t) => !PERSONAL_ONLY_TOOLS.has(t.name)) : ALL_TOOLS;
  return [...base, watchTool(dest)];
}

/**
 * `github_watch_pr` es la única que necesita el `dest` del turno: el aviso vuelve a ESTA
 * conversación. Como las nativas (`reminder_create`), el destino sale del token firmado y
 * no de los argumentos — el agente no puede mandar el aviso a otro sitio.
 */
function watchTool(dest: ToolDest | null): ConnectorTool {
  return {
    name: "github_watch_pr",
    description:
      "Vigila un pull request y te DESPIERTA en esta misma conversación cuando CI termina (verde o rojo), cuando se mergea o cuando se cierra — no tienes que quedarte esperando ni pedirle a nadie que te avise. Úsalo justo después de abrir un PR, de empujar un arreglo o de encender el auto-merge, y termina tu turno diciendo que vas a avisar. Dura 24 h.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, number: { type: "number", description: "Número del PR." } },
      required: ["repo", "number"],
    },
    handler: async (sub, a) => {
      const repo = normalizeRepo(a.repo);
      if (!repo) return BAD_REPO;
      const number = Number(a.number);
      if (!Number.isFinite(number) || number <= 0) return { error: "Falta el número del PR." };
      if (!dest?.handle || (dest.dmId == null && dest.channelId == null)) {
        return { error: "Sólo puedo vigilar un PR desde una conversación: aquí no hay a dónde avisarte." };
      }
      const snap = await prSnapshot(sub, repo, number);
      if ("error" in snap) return snap;
      if (snap.merged || snap.state === "closed") {
        return { error: `Ese PR ya está ${snap.merged ? "mergeado" : "cerrado"}: no hay nada que vigilar.` };
      }

      // La misma clave de conversación que usa un turno normal en ese sitio (chat.ts / dm.ts):
      // con otra, el despertador abriría una sesión nueva sin memoria de por qué vigilaba.
      const { resolvedAgents, agentGroupId } = await import("../../agents.server");
      const agent = (await resolvedAgents()).find((x) => x.handle === dest.handle);
      let suffix: string;
      if (dest.dmId != null) suffix = `dm-${dest.dmId}`;
      else {
        const { dbq } = await import("../../dbq.server");
        const rows = await dbq(`SELECT slug FROM gc_channels WHERE id = ?`, [dest.channelId]);
        const slug = String(rows[0]?.slug ?? "");
        if (!slug) return { error: "No encontré el room de esta conversación." };
        const { fleetSuffixFor } = await import("../apps/factory-session.server");
        suffix = await fleetSuffixFor(dest.handle, { id: Number(dest.channelId), slug }, dest.parentId ?? null);
      }
      const groupId = await agentGroupId(agent ?? { handle: dest.handle }, suffix);

      const { mintWakeRef } = await import("../wakeups.server");
      const { currentNamespace } = await import("../tenant.server");
      let origin = "";
      try {
        const { reqOrigin } = await import("../../origin.server");
        origin = (await reqOrigin()) || "";
      } catch { /* sin request: el turno despierto se degrada igual que uno de gs */ }
      let ref: string;
      try {
        ref = mintWakeRef({ sub, ns: await currentNamespace(), groupId, dest });
      } catch {
        return { error: "La vigilancia de PRs no está disponible en este espacio." };
      }
      const { upsertPrWatch } = await import("../pr-watches.server");
      await upsertPrWatch({
        repo, number, sub, groupId, ref, origin,
        memory: { sha: snap.sha, checks: snap.checks.state, greenSince: null },
      });
      return {
        ok: true,
        watching: `${repo}#${number}`,
        checksNow: snap.checks.state,
        autoMerge: snap.autoMerge,
        nota: "Te despierto aquí mismo cuando CI termine o el PR se mergee/cierre. Termina el turno sin esperar.",
      };
    },
  };
}
