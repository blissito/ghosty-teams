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
  if (res.status === 403) {
    // Rate limit y permiso faltante comparten el 403 en GitHub. Se distinguen
    // por el header, no por el cuerpo.
    if (res.headers.get("x-ratelimit-remaining") === "0") {
      return { error: "GitHub está limitando las peticiones. Espera unos minutos." };
    }
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
export const REPOLESS_TOOLS = new Set(["github_list_repos", "github_install_link"]);

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
  base: p?.base?.ref,
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
const repoProp = { repo: str('Repositorio como "dueño/repo".') };

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
            "Dale ese enlace tal cual y dile que ahí escoge los repos.",
        };
      }
      // Un usuario puede tener la app instalada en su cuenta personal Y en
      // varias organizaciones. Tomar sólo la primera dejaba invisibles los repos
      // del trabajo, que suelen ser los que importan.
      const perInstall = await Promise.all(
        installs.map(async (inst) => {
          const repos = await api(sub, `/user/installations/${inst.id}/repositories?per_page=100`);
          return (repos?.repositories ?? []).map((x: any) => ({
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
      "Devuelve los enlaces para instalar la app de Ghosty en una cuenta de GitHub, o para cambiar a qué repositorios tiene acceso. Úsala cuando pidan 'conecta mi repo', 'agrega este repo' o cuando otra tool falle porque el repo no está en la instalación.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ({
      // Es la misma liga para instalar y para agregar repos a una cuenta donde
      // ya está instalada: GitHub reconoce el estado y muestra la pantalla que
      // toca. Por eso no hay que decidir cuál mandar.
      instalarOAgregarRepos: INSTALL_URL,
      administrarInstalaciones: MANAGE_URL,
    }),
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
          return { error: `GitHub no pudo actualizar la rama (¿conflictos con la base?). ${r.error}` };
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
  // ── Paridad con el MCP oficial de GitHub (github/github-mcp-server), lo que usa la
  // Software Factory: commit de varios archivos, árbol, commits, comentarios en línea del
  // PR, reintentar CI, avisos de Dependabot y búsqueda de issues/PRs.
  {
    name: "github_push_files",
    description:
      "Varios archivos (crear, reemplazar o BORRAR) en UN solo commit sobre una rama de trabajo (nunca la principal). Prefiérela a github_write_file cuando el cambio toca más de un archivo: un commit por archivo deja la rama rota a medias.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        branch: str("Rama de trabajo."),
        message: str("Mensaje del commit."),
        files: {
          type: "array",
          description: "Cambios. `content` para crear/reemplazar; `delete: true` para borrar.",
          items: {
            type: "object",
            properties: { path: str("Ruta."), content: str("Contenido completo."), delete: { type: "boolean" } },
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
        if (!f.delete && typeof f.content !== "string") return { error: `${f.path}: falta \`content\` (o \`delete: true\`).` };
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
      const tree = await apiWith(w.token, `/repos/${p}/git/trees`, {
        method: "POST",
        body: JSON.stringify({
          base_tree: base?.tree?.sha,
          tree: files.map((f) =>
            f.delete
              ? { path: String(f.path).replace(/^\/+/, ""), mode: "100644", type: "blob", sha: null }
              : { path: String(f.path).replace(/^\/+/, ""), mode: "100644", type: "blob", content: String(f.content) },
          ),
        }),
      });
      if (tree?.error) return tree;
      const meta = w.bot ? await readMeta(sub) : null;
      const message = String(a.message) + (meta?.login ? coAuthorTrailer(meta.login) : "");
      const commit = await apiWith(w.token, `/repos/${p}/git/commits`, {
        method: "POST",
        body: JSON.stringify({ message, tree: tree?.sha, parents: [parent] }),
      });
      if (commit?.error) return commit;
      const moved = await apiWith(w.token, `/repos/${p}/git/refs/heads/${encodeURIComponent(branch)}`, {
        method: "PATCH",
        body: JSON.stringify({ sha: commit?.sha }),
      });
      if (moved?.error) return moved;
      return { ok: true, commit: commit?.sha, files: files.length, deleted: files.filter((f) => f.delete).length, asBot: w.bot };
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
      if (r?.error && /Sin permiso/.test(String(r.error)))
        return { error: "La GitHub App de Ghosty todavía no tiene el permiso «Actions: write» en este repo: el dueño lo acepta en GitHub (Settings → Applications → Ghosty)." };
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
      if (r?.error && /Sin permiso/.test(String(r.error)))
        return { error: "La GitHub App de Ghosty todavía no tiene el permiso «Dependabot alerts: read» en este repo: el dueño lo acepta en GitHub (Settings → Applications → Ghosty)." };
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
      "Comenta en un issue o pull request (en GitHub es el mismo hilo). Aparece con el nombre del usuario: confírmalo con él antes.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, number: { type: "number" }, body: str("El comentario, en Markdown.") },
      required: ["repo", "number", "body"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
      const r = await api(sub, `/repos/${p}/issues/${Number(a.number)}/comments`, {
        method: "POST",
        // Sale con la cuenta de la persona, así que lleva constancia de quién lo redactó.
        body: JSON.stringify({ body: String(a.body) + agentTrailer() }),
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
      "Crea o reemplaza un archivo en una rama, con su commit. Para SOBRESCRIBIR uno que ya existe hay que pasar su `sha` (lo devuelve github_read_file) — sin él GitHub rechaza el cambio para no pisar trabajo ajeno. Escribe en una rama de trabajo, nunca en la principal.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        path: str("Ruta del archivo."),
        content: str("Contenido COMPLETO del archivo (no un parche)."),
        message: str("Mensaje del commit."),
        branch: str("Rama donde commitear."),
        sha: str("SHA del archivo actual. Obligatorio si el archivo ya existe."),
      },
      required: ["repo", "path", "content", "message", "branch"],
    },
    handler: async (sub, a) => {
      const p = repoPath(a.repo);
      if (!p) return BAD_REPO;
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
          content: Buffer.from(String(a.content), "utf8").toString("base64"),
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
  return [...ALL_TOOLS, watchTool(dest)];
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
        suffix = `${slug}-flow`;
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
