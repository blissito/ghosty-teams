// «Listo para agentes»: qué tan preparado está un repo para que la Software Factory trabaje
// en él, y qué archivos faltan para prepararlo.
//
// Los criterios NO son inventados; cada uno sale de una referencia de la industria:
//  - OpenSSF Scorecard (checks CI-Tests, Code-Review, Dependency-Update-Tool, Branch-Protection);
//  - AGENTS.md (formato abierto de la Agentic AI Foundation / Linux Foundation, lo leen Codex,
//    Copilot, Cursor, goose, Factory…);
//  - Agent Readiness de Factory (niveles; «Functional» = README, dependencias, build/test);
//  - previews por PR (el modelo de Vercel/Render): el cambio se VE antes de mezclarse y
//    @check lo prueba ahí. La da el hosting si la publica; si no, nuestra caja (ver
//    preview.server.ts), para la que basta que el repo arranque y tenga sus variables.
// La UI enseña la fuente de cada criterio, para que el cliente vea por qué se le pide.
//
// Todo se comprueba contra GitHub con el token de quien conectó el repo al room (así lo ve
// cualquier miembro, aunque no tenga GitHub conectado). Se cachea 10 min por repo; cerrar un
// pedido de ese repo o proteger main lo invalida.
import { githubApi } from "../connectors/github.server";

export type ReadinessKey =
  | "readme"
  | "lockfile"
  | "scripts"
  | "agents_md"
  | "ci"
  | "codeowners"
  | "dependabot"
  | "protected"
  | "preview";

export type ReadinessCheck = {
  key: ReadinessKey;
  level: 1 | 2 | 3;
  ok: boolean;
  /** «Preparar repo» lo puede arreglar en el PR (los scripts y la protección, no). */
  fixable: boolean;
};

export type Readiness = {
  repo: string;
  /** Nivel alcanzado: el más alto con TODOS sus criterios (y los de abajo) cumplidos. 0 = ninguno. */
  level: 0 | 1 | 2 | 3;
  passed: number;
  total: number;
  checks: ReadinessCheck[];
  /** Datos para armar los archivos de preparación sin volver a preguntarle a GitHub. */
  facts: RepoFacts;
  checkedAt: number;
};

export type RepoFacts = {
  owner: string;
  defaultBranch: string;
  pm: "npm" | "pnpm" | "yarn" | null;
  scripts: Record<string, string>;
  hasClaudeMd: boolean;
  missingScripts: string[];
  /** Previews: del hosting, o las de nuestra caja si el repo arranca y tiene sus variables. */
  previewHosting: boolean;
  previewRunnable: boolean;
  envExampleKeys: string[];
  /** Nombres de las variables guardadas para la preview (null = ninguna). */
  envSavedKeys: string[] | null;
};

export const LEVELS: Record<1 | 2 | 3, ReadinessKey[]> = {
  1: ["readme", "lockfile", "scripts"],
  2: ["agents_md", "ci"],
  3: ["codeowners", "dependabot", "protected", "preview"],
};

/** Qué criterio arregla «Preparar repo». Los scripts piden dependencias: nunca a ciegas. */
const FIXABLE: Record<ReadinessKey, boolean> = {
  readme: true,
  lockfile: false,
  scripts: false,
  agents_md: true,
  ci: true,
  codeowners: true,
  dependabot: true,
  protected: false,
  // La da el hosting o nuestra caja; lo que falta (variables) no va en un PR.
  preview: false,
};

/** Nivel alcanzado a partir de los criterios (puro, para probarlo). */
export function levelOf(ok: Partial<Record<ReadinessKey, boolean>>): 0 | 1 | 2 | 3 {
  let level: 0 | 1 | 2 | 3 = 0;
  for (const l of [1, 2, 3] as const) {
    if (LEVELS[l].every((k) => ok[k])) level = l;
    else break;
  }
  return level;
}

const names = (r: any): string[] => (Array.isArray(r) ? r.map((f: any) => String(f?.name ?? "")) : []);

function decode(r: any): string | null {
  if (!r || r.error || typeof r.content !== "string") return null;
  try {
    return Buffer.from(r.content, "base64").toString("utf8");
  } catch {
    return null;
  }
}

/** CODEOWNERS que cubre `/.github/` (o todo el repo): los cambios al CI los revisa una persona. */
export function codeownersCoversGithub(text: string | null): boolean {
  if (!text) return false;
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .some((l) => /^(\*|\/?\.github\/?(\*\*)?)\s+@/.test(l));
}

const cache = new Map<string, Readiness>();
const TTL = 10 * 60_000;

export function invalidateReadiness(repo: string): void {
  cache.delete(repo);
}

export async function repoReadiness(sub: string, repo: string, opts: { fresh?: boolean } = {}): Promise<Readiness | { error: string }> {
  const hit = cache.get(repo);
  if (!opts.fresh && hit && Date.now() - hit.checkedAt < TTL) return hit;

  const info = await githubApi(sub, `/repos/${repo}`);
  if (info?.error) return { error: String(info.error) };
  const owner = String(info?.owner?.login ?? repo.split("/")[0]);
  const defaultBranch = String(info?.default_branch ?? "main");

  const [root, gh, workflows, branch] = await Promise.all([
    githubApi(sub, `/repos/${repo}/contents/`),
    githubApi(sub, `/repos/${repo}/contents/.github`),
    githubApi(sub, `/repos/${repo}/contents/.github/workflows`),
    githubApi(sub, `/repos/${repo}/branches/${encodeURIComponent(defaultBranch)}`),
  ]);
  const rootFiles = names(root);
  const ghFiles = names(gh);
  const has = (f: string) => rootFiles.some((n) => n.toLowerCase() === f.toLowerCase());

  const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("package-lock.json") ? "npm" : null;
  let scripts: Record<string, string> = {};
  if (has("package.json")) {
    const pkg = decode(await githubApi(sub, `/repos/${repo}/contents/package.json`));
    try {
      scripts = (pkg ? JSON.parse(pkg)?.scripts : null) ?? {};
    } catch {
      scripts = {};
    }
  }
  const missingScripts = ["test", ...(scripts.typecheck || scripts.lint ? [] : ["typecheck"])].filter((s) => !scripts[s]);

  // CODEOWNERS puede vivir en la raíz, en .github/ o en docs/ (GitHub mira los tres).
  const coPath = ghFiles.includes("CODEOWNERS") ? ".github/CODEOWNERS" : has("CODEOWNERS") ? "CODEOWNERS" : null;
  const codeowners = coPath ? decode(await githubApi(sub, `/repos/${repo}/contents/${coPath}`)) : null;

  // Protegida = el ruleset de la fábrica, o cualquier protección que GitHub reporte en la rama.
  const { protectionState } = await import("./ci-starter.server");
  const protection = await protectionState(sub, repo).catch(() => "error" as const);
  const P = await import("./preview.server");
  const previewHosting = await P.repoHasPreviews(sub, repo, defaultBranch).catch(() => false);
  const previewRunnable = (has("package.json") && !!(scripts.start || scripts.preview || scripts.dev)) || has("index.html");
  const envExampleKeys = has(".env.example") ? P.envExampleKeys(decode(await githubApi(sub, `/repos/${repo}/contents/.env.example`))) : [];
  const envSavedKeys: string[] | null = await P.gsPreview("env-keys", { repo })
    .then((r) => (Array.isArray(r?.keys) ? r.keys : null))
    .catch(() => null);
  const previews = previewHosting || (previewRunnable && (envExampleKeys.length === 0 || !!envSavedKeys));

  const ok: Record<ReadinessKey, boolean> = {
    readme: rootFiles.some((n) => /^readme(\.|$)/i.test(n)),
    lockfile: !!pm,
    scripts: missingScripts.length === 0,
    agents_md: has("AGENTS.md"),
    ci: names(workflows).some((n) => /\.ya?ml$/i.test(n)),
    codeowners: codeownersCoversGithub(codeowners),
    dependabot: ghFiles.some((n) => /^dependabot\.ya?ml$/i.test(n)) || has("renovate.json"),
    protected: protection === "protected" || branch?.protected === true,
    preview: previews,
  };
  const checks: ReadinessCheck[] = ([1, 2, 3] as const).flatMap((level) =>
    LEVELS[level].map((key) => ({ key, level, ok: ok[key], fixable: FIXABLE[key] })),
  );
  const out: Readiness = {
    repo,
    level: levelOf(ok),
    passed: checks.filter((c) => c.ok).length,
    total: checks.length,
    checks,
    facts: {
      owner,
      defaultBranch,
      pm,
      scripts,
      hasClaudeMd: has("CLAUDE.md"),
      missingScripts,
      previewHosting,
      previewRunnable,
      envExampleKeys,
      envSavedKeys,
    },
    checkedAt: Date.now(),
  };
  cache.set(repo, out);
  return out;
}

// ── Los archivos de la preparación ───────────────────────────────────────────

const runCmd = (pm: RepoFacts["pm"], s: string) => (pm === "pnpm" ? `pnpm ${s}` : pm === "yarn" ? `yarn ${s}` : `npm run ${s}`);
const installCmd = (pm: RepoFacts["pm"]) =>
  pm === "pnpm" ? "pnpm install --frozen-lockfile" : pm === "yarn" ? "yarn install --frozen-lockfile" : "npm ci";

/**
 * Esqueleto de AGENTS.md con lo que SÍ se sabe del repo (gestor y scripts reales). Las
 * secciones siguen las que recomienda agents.md; @build completa «Arquitectura» y «Qué no
 * tocar» leyendo el código. Si hay CLAUDE.md, se remite a él en vez de duplicarlo.
 */
export function agentsMdSkeleton(f: RepoFacts): string {
  const cmd = (s: string) => (f.scripts[s] ? `- \`${runCmd(f.pm, s)}\`` : null);
  const commands = [
    `- \`${installCmd(f.pm)}\` — instalar`,
    cmd("dev") && `${cmd("dev")} — levantar en local`,
    cmd("typecheck") && `${cmd("typecheck")} — tipos`,
    cmd("lint") && `${cmd("lint")} — lint`,
    f.scripts.test ? `- \`${f.pm === "npm" || !f.pm ? "npm test" : `${f.pm} test`}\` — pruebas` : null,
    cmd("build") && `${cmd("build")} — build`,
  ].filter(Boolean);
  return `# AGENTS.md

Instrucciones para agentes de código (formato abierto: https://agents.md).${
    f.hasClaudeMd ? "\nLas reglas detalladas del proyecto viven en `CLAUDE.md`: léelo también." : ""
  }

## Comandos
${commands.join("\n")}

Antes de abrir un PR, todo lo anterior tiene que pasar en local.

## Arquitectura
<!-- @build: 3-6 renglones — carpetas principales y qué vive en cada una. -->

## Convenciones
- Cambios chicos y con pruebas; un PR por pedido.
- No agregues dependencias sin decirlo en el PR.

## Qué no tocar
- \`.github/\` (CI y reglas del repo): los cambios ahí los revisa una persona.
- Secretos y archivos \`.env*\`: nunca se suben al repo.
<!-- @build: agrega aquí lo que no deba tocarse (datos de producción, migraciones ya aplicadas…). -->

## Pull requests
- Rama nueva desde \`${f.defaultBranch}\`; el PR explica qué cambia y cómo se probó.
- El CI tiene que quedar en verde.
`;
}

export function dependabotYml(f: RepoFacts): string {
  const eco = f.pm ? "npm" : null;
  return `# Actualizaciones de dependencias (Software Factory de Ghosty). Agrupadas y semanales para no llenar de PRs.
version: 2
updates:
${
  eco
    ? `  - package-ecosystem: npm
    directory: "/"
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
    groups:
      minor-and-patch:
        update-types: [minor, patch]
`
    : ""
}  - package-ecosystem: github-actions
    directory: "/"
    schedule:
      interval: weekly
    groups:
      actions:
        patterns: ["*"]
`;
}

export function readmeSkeleton(repo: string, f: RepoFacts): string {
  const name = repo.split("/")[1] ?? repo;
  const cmds = [installCmd(f.pm), f.scripts.dev ? runCmd(f.pm, "dev") : null].filter(Boolean).join("\n");
  return `# ${name}

<!-- @build: una línea de qué es este proyecto. -->

## Cómo correrlo

\`\`\`sh
${cmds}
\`\`\`
`;
}

/** Plan del pedido «Preparar repo», con SÓLO lo que falta. Lo arma la plataforma, no @plan. */
export function preparationPlan(r: Readiness): { title: string; planMd: string; fixes: ReadinessKey[] } {
  const miss = (k: ReadinessKey) => r.checks.some((c) => c.key === k && !c.ok);
  const fixes = r.checks.filter((c) => !c.ok && c.fixable).map((c) => c.key);
  const steps: string[] = [];
  if (miss("ci")) steps.push("- `.github/workflows/ci.yml` — las pruebas corren solas en cada PR (tipos, lint, pruebas, build, secretos y dependencias).");
  if (miss("codeowners")) steps.push("- `.github/CODEOWNERS` — los cambios a `.github/` los revisa una persona.");
  if (miss("dependabot")) steps.push("- `.github/dependabot.yml` — dependencias al día, agrupadas y semanales.");
  if (miss("agents_md"))
    steps.push(
      `- \`AGENTS.md\` — reglas para agentes de código${r.facts.hasClaudeMd ? " (remite a `CLAUDE.md`)" : ""}. Completa «Arquitectura» y «Qué no tocar» leyendo el repo.`,
    );
  if (miss("readme")) steps.push("- `README.md` — qué es y cómo correrlo.");
  const later: string[] = [];
  if (miss("scripts"))
    later.push(`- Faltan scripts en package.json: ${r.facts.missingScripts.map((s) => `\`${s}\``).join(", ")}. Piden elegir herramientas: va en su propio pedido.`);
  if (miss("lockfile")) later.push("- No hay lockfile: instala una vez en local y súbelo (`npm install` genera `package-lock.json`).");
  if (miss("preview"))
    later.push(
      r.facts.previewRunnable
        ? "- Previews por PR: guarda las variables de la preview (con datos de prueba) en «Listo para agentes» → Variables. La fábrica levanta una por PR y @check prueba ahí."
        : "- Previews por PR: el repo no tiene cómo arrancarse (`start`, `preview` o `dev` en package.json). Con eso, la fábrica levanta una por PR.",
    );
  if (miss("protected")) later.push("- Proteger la rama principal: lo activa el dueño con un clic en «Listo para agentes» cuando este PR se mezcle.");

  const planMd = `# Preparar ${r.repo} para agentes

Pedido armado por la plataforma a partir de la revisión «Listo para agentes» (nivel ${r.level} de 3, ${r.passed}/${r.total}).
Criterios de OpenSSF Scorecard y del estándar AGENTS.md.

## Qué entra en este PR
${steps.join("\n")}

## Cómo
1. Llama \`factory_repo_prep\` (repo ${r.repo}): devuelve los archivos listos.
2. Escríbelos TAL CUAL en una rama nueva; sólo completa los comentarios \`<!-- @build: … -->\` leyendo el repo.
3. Abre el PR en borrador y cierra con \`factory_build_done\`.

## Criterios de aceptación
- El PR sólo agrega esos archivos; no toca código de la app.
- El CI nuevo corre en el PR y queda en verde (o el hallazgo dice qué script falla).
- \`AGENTS.md\` lista comandos que existen en \`package.json\`.
${later.length ? `\n## Fuera de este PR\n${later.join("\n")}\n` : ""}`;
  return { title: `Preparar ${r.repo.split("/")[1] ?? r.repo} para agentes`, planMd, fixes };
}

/** Los archivos que faltan, listos para escribir. El CI y CODEOWNERS salen del CI starter. */
export async function preparationFiles(
  sub: string,
  r: Readiness,
  runnerLabel: string | null,
): Promise<{ files: { path: string; content: string }[]; notes: string[] } | { error: string }> {
  const miss = (k: ReadinessKey) => r.checks.some((c) => c.key === k && !c.ok);
  const files: { path: string; content: string }[] = [];
  const notes: string[] = [];
  if (miss("ci") || miss("codeowners")) {
    const { buildCiStarter } = await import("./ci-starter.server");
    const ci = await buildCiStarter(sub, r.repo, runnerLabel);
    if ("error" in ci) return ci;
    for (const f of ci.files) {
      if (f.path.endsWith("ci.yml") && !miss("ci")) continue;
      if (f.path.endsWith("CODEOWNERS") && !miss("codeowners")) continue;
      files.push(f);
    }
    notes.push(...ci.notes);
  }
  if (miss("dependabot")) files.push({ path: ".github/dependabot.yml", content: dependabotYml(r.facts) });
  if (miss("agents_md")) files.push({ path: "AGENTS.md", content: agentsMdSkeleton(r.facts) });
  if (miss("readme")) files.push({ path: "README.md", content: readmeSkeleton(r.repo, r.facts) });
  return { files, notes };
}
