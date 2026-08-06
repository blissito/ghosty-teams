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
import type { ConnectorTool } from "./impl";
import {
  appJwtOrNull,
  botIdentityEnabled,
  coAuthorTrailer,
  installationToken,
  pushDenialReason,
} from "./github-app.server";

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
  base: p?.base?.ref,
  changedFiles: p?.changed_files,
  additions: p?.additions,
  deletions: p?.deletions,
});

// ── Contexto ambiente ────────────────────────────────────────────────────────

export async function ambientContext(sub: string, sender: string, _message: string): Promise<string | null> {
  const meta = await readMeta(sub);
  if (!meta) return null;

  return (
    `[INTEGRACIÓN GitHub de ${sender} (conectada como @${meta.login}). ` +
    `TIENES HERRAMIENTAS para sus repos vía el GS Tools SDK: importa /opt/gs-sdk/connectors.mjs y usa ` +
    `list() y run(name, args). Lectura: github_list_repos, github_list_issues, github_get_issue, ` +
    `github_list_prs, github_get_pr, github_pr_files, github_read_file, github_search_code, ` +
    `github_workflow_runs, github_workflow_run_logs. Escritura: github_create_review, github_comment, github_update_issue, github_create_issue, ` +
    `github_create_branch, github_write_file, github_create_pr. ` +
    `Si te piden "conecta mi repo" o "agrega este repo", contesta con github_install_link. ` +
    `Para CUALQUIER pregunta sobre repos, issues, pull requests o CI de ${sender}, USA estas tools — ` +
    `NO inventes datos ni digas que no tienes acceso (SÍ lo tienes). El repo va como "dueño/repo". ` +
    `Antes de opinar de un PR lee su DIFF con github_pr_files, no sólo el título. ` +
    // Blue se salió a raw.githubusercontent.com al toparse con un archivo truncado.
    // Funciona en un repo público y da 404 en uno privado — los del cliente.
    `Para leer un archivo usa SIEMPRE github_read_file, nunca raw.githubusercontent.com ni un fetch ` +
    `directo: en un repo privado eso falla. Si viene truncated, sigue con el nextOffset que te da. ` +
    `Para escribir código: crea una rama con github_create_branch, escribe con github_write_file y abre ` +
    `un PR con github_create_pr — NUNCA escribas directo sobre la rama principal. ` +
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
    `Le pinta a la persona los botones de Aprobar / Pedir cambios / Rechazar, que se ejecutan ` +
    `con SU cuenta. Pon SÓLO campos que hayas leído de verdad (los conteos salen de github_get_pr ` +
    `y github_pr_files; \`checks\` de github_workflow_runs) — si no lo miraste, omite el campo, ` +
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

export const tools: ConnectorTool[] = [
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
    name: "github_workflow_run_logs",
    description:
      "El LOG de una corrida de GitHub Actions que falló: qué job y qué paso reventaron, y las líneas de error. Es lo que de verdad responde '¿por qué está roja la build?' — github_workflow_runs sólo da el estado. Pásale el `id` que devolvió esa tool. Nunca inventes una línea de log: si esto falla, di que no lo pudiste leer y da la url del run.",
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
          note: "Ningún job de este run terminó en failure. Puede seguir corriendo, o la corrida roja ser otra.",
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
        body: JSON.stringify({ body: String(a.body) }),
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
        body: JSON.stringify({ title: a.title, body: a.body, labels: a.labels, assignees: a.assignees }),
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
