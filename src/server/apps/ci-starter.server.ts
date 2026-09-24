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

/** ¿El repo ya tiene workflows de CI? */
export async function hasWorkflows(sub: string, repo: string): Promise<boolean> {
  const r = await githubApi(sub, `/repos/${repo}/contents/.github/workflows`);
  return Array.isArray(r) && r.some((f: any) => /\.ya?ml$/i.test(String(f?.name ?? "")));
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

  const [pnpm, yarn, nvmrc] = await Promise.all([
    exists(sub, repo, "pnpm-lock.yaml"),
    exists(sub, repo, "yarn.lock"),
    exists(sub, repo, ".nvmrc"),
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
      - uses: ${a.depReview}
        with:
          fail-on-severity: high
`;
  const codeowners = `# Los cambios al CI y a esta regla los revisa una persona (Software Factory de Ghosty).\n/.github/ @${owner}\n`;
  const notes: string[] = [];
  if (unpinned.length) notes.push(`No pude fijar por SHA: ${unpinned.join(", ")} (quedaron con su tag).`);
  if (runnerLabel) notes.push(`Corre en la caja de CI del espacio (${runnerLabel}): caché caliente y sin fila.`);
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

export type ProtectionState = "protected" | "unprotected" | "no_permission" | "error";

export async function protectionState(sub: string, repo: string): Promise<ProtectionState> {
  const r = await githubApi(sub, `/repos/${repo}/rulesets`);
  if (r?.error) return /permiso|permission/i.test(String(r.error)) ? "no_permission" : "error";
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
