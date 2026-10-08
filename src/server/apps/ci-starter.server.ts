// CI starter y protección de `main` para la Software Factory.
//
// Lo que la industria da por mínimo en un repo donde escriben agentes (investigación del
// 2026-09-24, ver docs/claude/software-factory-producto.md): CI con typecheck/lint/test/
// build, escaneo de secretos y revisión de dependencias, actions fijadas por SHA, permisos
// mínimos, timeouts; y una regla en la rama principal que exija PR, aprobación y CI en verde
// — que GitHub lo haga cumplir, no sólo @check.
//
// Todo con el token de una PERSONA (`githubApi(sub, …)`): el CI lo escribe @build en un PR
// que se firma; la protección la activa el dueño con un clic (nunca un agente: con
// `administration` podría quitarla).
import { githubApi } from "../connectors/github.server";

/** Las actions del workflow, por tag. El SHA se resuelve al generarlo (tj-actions, 2025). */
const ACTIONS: Record<string, string> = {
  checkout: "actions/checkout@v4",
  setupNode: "actions/setup-node@v4",
  pnpm: "pnpm/action-setup@v4",
  gitleaks: "gitleaks/gitleaks-action@v2",
  depReview: "actions/dependency-review-action@v4",
};

/** Los checks que el starter crea: son los que la protección de main exige. */
export const CI_CHECKS = ["verify", "security"];

async function pin(sub: string, ref: string): Promise<string> {
  const [repo, tag] = ref.split("@");
  const r = await githubApi(sub, `/repos/${repo}/commits/${encodeURIComponent(tag)}`);
  const sha = typeof r?.sha === "string" ? r.sha : null;
  // Si GitHub no contesta se deja el tag: mejor un CI con tag que ningún CI. Se avisa.
  return sha ? `${repo}@${sha} # ${tag}` : ref;
}

async function exists(sub: string, repo: string, path: string): Promise<boolean> {
  const r = await githubApi(sub, `/repos/${repo}/contents/${path}`);
  return !!r && !r.error;
}

/**
 * Los workflows que corren en los PR. Tener un `.yml` no basta: MailMask sólo tenía `deploy.yml`
 * (push a main), «Preparar repo» lo dio por CI y sus PR llegaban a @check sin un solo check (4-oct).
 * `listing` = lo que ya devolvió `contents/.github/workflows`, para no pedirlo dos veces.
 */
async function prWorkflows(sub: string, repo: string, listing?: unknown): Promise<{ path: string; text: string }[]> {
  const r = listing ?? (await githubApi(sub, `/repos/${repo}/contents/.github/workflows`));
  if (!Array.isArray(r)) return [];
  const files = r.filter((f: any) => /\.ya?ml$/i.test(String(f?.name ?? ""))).slice(0, 10);
  const texts = await Promise.all(
    files.map((f: any) =>
      githubApi(sub, `/repos/${repo}/contents/${String(f.path)}`)
        .then((c: any) => ({ path: String(f.path), text: typeof c?.content === "string" ? Buffer.from(c.content, "base64").toString("utf8") : "" }))
        .catch(() => ({ path: String(f.path), text: "" })),
    ),
  );
  return texts.filter((t) => /\bpull_request(_target)?\b/.test(t.text));
}

/** ¿El repo corre CI en los PR? */
export async function hasWorkflows(sub: string, repo: string, listing?: unknown): Promise<boolean> {
  return (await prWorkflows(sub, repo, listing)).length > 0;
}

/** Los scripts que el CI tiene que correr si el repo los trae. */
export const CI_SCRIPTS = ["typecheck", "lint", "test", "build"] as const;

/**
 * Qué scripts del repo no corre ningún workflow de PR. Tener CI no basta: el #17 existió porque
 * el CI del chat sólo probaba y nadie vio que no revisaba tipos ni compilaba (7-oct).
 * Cuenta como cubierto `<pm> [run] [--if-present] <script>` o el comando del script tal cual.
 */
export function uncoveredScripts(texts: string[], scripts: Record<string, string>): string[] {
  const all = texts.join("\n");
  return CI_SCRIPTS.filter((s) => {
    const cmd = scripts[s]?.trim();
    if (!cmd) return false;
    const viaPm = new RegExp(`\\b(npm|pnpm|yarn|bun)\\b[^\\n]*?\\s${s}(?![\\w:-])`).test(all);
    return !viaPm && !all.includes(cmd);
  });
}

/** Cobertura del CI de PR: si existe, cuál es y qué scripts del repo le faltan. */
export async function ciCoverage(
  sub: string,
  repo: string,
  scripts: Record<string, string>,
  listing?: unknown,
): Promise<{ onPr: boolean; path: string | null; missing: string[]; docker: boolean }> {
  const wf = await prWorkflows(sub, repo, listing);
  if (!wf.length) return { onPr: false, path: null, missing: CI_SCRIPTS.filter((s) => !!scripts[s]), docker: false };
  const texts = wf.map((w) => w.text);
  return { onPr: true, path: wf[0].path, missing: uncoveredScripts(texts, scripts), docker: buildsDocker(texts) };
}

/** ¿Algún workflow de PR construye la imagen? Con Dockerfile, un PR que no compila la imagen
 *  rompe hasta el deploy (MailMask #17: el bundle pasaba las pruebas y tumbaba el build, 8-oct). */
export function buildsDocker(texts: string[]): boolean {
  return texts.some((t) => /docker\/build-push-action|\bdocker\s+(buildx\s+)?build\b/.test(t));
}

/**
 * El workflow que despliega a producción en cada push a la rama principal, y si declara
 * `environment: production` (así GitHub enseña «deployed to production» en el PR y el repo
 * lleva la lista de despliegues). null = el repo no despliega por Actions.
 */
export function deployWorkflowOf(files: { path: string; text: string }[]): { path: string; hasEnv: boolean } | null {
  for (const f of files) {
    const pushes = /^\s*(on:\s*\[?[^\n]*\bpush\b|push:)/m.test(f.text);
    const deploys = /\b(flyctl|fly deploy|vercel|netlify|wrangler|railway|render\.com|deploy)\b/i.test(f.text.replace(/^\s*name:.*$/gm, ""));
    if (!pushes || !deploys || /\bpull_request\b/.test(f.text)) continue;
    const hasEnv = /^\s*environment:\s*['"]?production\b/m.test(f.text) || /^\s*environment:\s*\n\s*name:\s*['"]?production\b/m.test(f.text);
    return { path: f.path, hasEnv };
  }
  return null;
}

export async function deployWorkflow(sub: string, repo: string, listing?: unknown): Promise<{ path: string; hasEnv: boolean } | null> {
  const r = listing ?? (await githubApi(sub, `/repos/${repo}/contents/.github/workflows`));
  if (!Array.isArray(r)) return null;
  const files = r.filter((f: any) => /\.ya?ml$/i.test(String(f?.name ?? ""))).slice(0, 10);
  const texts = await Promise.all(
    files.map((f: any) =>
      githubApi(sub, `/repos/${repo}/contents/${String(f.path)}`)
        .then((c: any) => ({ path: String(f.path), text: typeof c?.content === "string" ? Buffer.from(c.content, "base64").toString("utf8") : "" }))
        .catch(() => ({ path: String(f.path), text: "" })),
    ),
  );
  return deployWorkflowOf(texts);
}

export type CiStarter = { files: { path: string; content: string }[]; notes: string[] };

/** Arma el workflow y el CODEOWNERS para `repo`, adaptados a su gestor de paquetes. */
export async function buildCiStarter(
  sub: string,
  repo: string,
  /** Etiqueta del runner propio del espacio (`ws-<slug>`): con caja de CI, el job corre ahí. */
  runnerLabel?: string | null,
): Promise<CiStarter | { error: string }> {
  const info = await githubApi(sub, `/repos/${repo}`);
  if (info?.error) return { error: info.error };
  const owner = String(info?.owner?.login ?? repo.split("/")[0]);
  const isOrg = String(info?.owner?.type ?? "") === "Organization";
  // dependency-review sólo corre en repos públicos o con Advanced Security. En un privado
  // sin GHAS falla SIEMPRE («Dependency review is not supported on this repository») y el
  // pedido de preparar el repo daba vueltas build→check sin salida (palmera-legal, 2-oct).
  const depReviewOk = !info?.private || info?.security_and_analysis?.advanced_security?.status === "enabled";

  const [pnpm, yarn, nvmrc, dockerfile] = await Promise.all([
    exists(sub, repo, "pnpm-lock.yaml"),
    exists(sub, repo, "yarn.lock"),
    exists(sub, repo, ".nvmrc"),
    exists(sub, repo, "Dockerfile"),
  ]);
  const pm = pnpm ? "pnpm" : yarn ? "yarn" : "npm";
  const install = pm === "pnpm" ? "pnpm install --frozen-lockfile" : pm === "yarn" ? "yarn install --frozen-lockfile" : "npm ci";
  const run = (script: string) => (pm === "npm" ? `npm run ${script} --if-present` : `${pm} run --if-present ${script}`);
  const test = pm === "npm" ? "npm test --if-present" : `${pm} run --if-present test`;

  const a = Object.fromEntries(await Promise.all(Object.entries(ACTIONS).map(async ([k, v]) => [k, await pin(sub, v)])));
  const unpinned = Object.values(a).filter((x) => !String(x).includes(" # "));

  const node = nvmrc ? "node-version-file: .nvmrc" : "node-version: 22";
  // La caja de CI del espacio (caché caliente, sin fila) cuando existe; si no, GitHub.
  const runsOn = runnerLabel ? `[self-hosted, ${runnerLabel}]` : "ubuntu-latest";
  const workflow = `# CI de la Software Factory de Ghosty. Lo exige la protección de la rama principal.
name: ci
on:
  pull_request:
  push:
    branches: [${info?.default_branch ?? "main"}]
permissions:
  contents: read
concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}
jobs:
  verify:
    runs-on: ${runsOn}
    timeout-minutes: 15
    steps:
      - uses: ${a.checkout}
        with:
          persist-credentials: false
${pm === "pnpm" ? `      - uses: ${a.pnpm}\n` : ""}      - uses: ${a.setupNode}
        with:
          ${node}
          cache: ${pm}
      - run: ${install}
      - run: ${run("typecheck")}
      - run: ${run("lint")}
      - run: ${test}
      - run: ${run("build")}
  security:
    if: github.event_name == 'pull_request'
    runs-on: ${runsOn}
    timeout-minutes: 10
    steps:
      - uses: ${a.checkout}
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: ${a.gitleaks}
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
${depReviewOk ? `      - uses: ${a.depReview}\n        with:\n          fail-on-severity: high\n` : ""}${
    dockerfile
      ? `  docker:
    if: github.event_name == 'pull_request'
    runs-on: ${runsOn}
    timeout-minutes: 20
    steps:
      - uses: ${a.checkout}
        with:
          persist-credentials: false
      # Sólo comprueba que la imagen se construye; nunca la sube.
      - run: docker build -t ci-check .
`
      : ""
  }`;
  const codeowners = `# Los cambios al CI y a esta regla los revisa una persona (Software Factory de Ghosty).\n/.github/ @${owner}\n`;
  const notes: string[] = [];
  if (unpinned.length) notes.push(`No pude fijar por SHA: ${unpinned.join(", ")} (quedaron con su tag).`);
  if (runnerLabel) notes.push(`Corre en la caja de CI del espacio (${runnerLabel}): caché caliente y sin fila.`);
  if (!depReviewOk) notes.push("Repo privado sin Advanced Security: no agregué dependency-review (GitHub no lo deja correr ahí). Se suma cuando se active en Settings → Code security.");
  if (isOrg) notes.push("El repo es de una organización: gitleaks-action pide el secreto GITLEAKS_LICENSE (gratis para uso no comercial).");
  return {
    files: [
      { path: ".github/workflows/ci.yml", content: workflow },
      { path: ".github/CODEOWNERS", content: codeowners },
    ],
    notes,
  };
}

// ── Proteger la rama principal (ruleset) ─────────────────────────────────────

export const RULESET_NAME = "Ghosty Factory";

/** `plan_required`: repo PRIVADO en una cuenta gratis — GitHub no deja proteger ramas ahí
 *  (rulesets ni protección clásica) sin GitHub Pro/Team. No es un permiso nuestro. */
export type ProtectionState = "protected" | "unprotected" | "no_permission" | "plan_required" | "error";

export const PLAN_REQUIRED = /upgrade to github pro|make this repository public/i;

export async function protectionState(sub: string, repo: string): Promise<ProtectionState> {
  const r = await githubApi(sub, `/repos/${repo}/rulesets`);
  if (r?.error) {
    if (PLAN_REQUIRED.test(String(r.error))) return "plan_required";
    return /permiso|permission/i.test(String(r.error)) ? "no_permission" : "error";
  }
  return Array.isArray(r) && r.some((x: any) => x?.name === RULESET_NAME) ? "protected" : "unprotected";
}

/** Los checks que de verdad corren en la cabeza de la rama principal (sus nombres). */
async function observedChecks(sub: string, repo: string): Promise<string[]> {
  const info = await githubApi(sub, `/repos/${repo}`);
  const branch = String(info?.default_branch ?? "main");
  const r = await githubApi(sub, `/repos/${repo}/commits/${encodeURIComponent(branch)}/check-runs?per_page=50`);
  const names = Array.isArray(r?.check_runs) ? r.check_runs.map((c: any) => String(c?.name ?? "")).filter(Boolean) : [];
  return [...new Set<string>(names)];
}

/**
 * Crea (o actualiza) el ruleset «Ghosty Factory» sobre la rama por defecto: PR obligatorio
 * con 1 aprobación (y la de CODEOWNERS), aprobaciones viejas descartadas al empujar, CI en
 * verde, sin force-push ni borrado. Sin bypass.
 *
 * ⚠️ Los checks exigidos son los que YA corren en la rama principal, no nombres supuestos:
 * exigir un check que el repo no produce bloquea todo PR para siempre. Sin CI todavía, la
 * regla no exige checks; al mezclar el CI starter se vuelve a proteger y ya los exige.
 */
export async function protectMain(sub: string, repo: string): Promise<{ ok: true; checks: string[] } | { error: string }> {
  const checks = await observedChecks(sub, repo);
  const rules: any[] = [
    { type: "deletion" },
    { type: "non_fast_forward" },
    {
      type: "pull_request",
      parameters: {
        required_approving_review_count: 1,
        dismiss_stale_reviews_on_push: true,
        require_code_owner_review: true,
        require_last_push_approval: false,
        required_review_thread_resolution: false,
      },
    },
  ];
  if (checks.length) {
    rules.push({
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: false,
        required_status_checks: checks.map((context) => ({ context })),
      },
    });
  }
  const body = JSON.stringify({
    name: RULESET_NAME,
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules,
  });
  const list = await githubApi(sub, `/repos/${repo}/rulesets`);
  const existing = Array.isArray(list) ? list.find((x: any) => x?.name === RULESET_NAME) : null;
  const r = existing
    ? await githubApi(sub, `/repos/${repo}/rulesets/${existing.id}`, { method: "PUT", body })
    : await githubApi(sub, `/repos/${repo}/rulesets`, { method: "POST", body });
  if (r?.error) return { error: String(r.error) };
  return { ok: true, checks };
}
