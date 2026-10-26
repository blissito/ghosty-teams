// «Safe-outputs» de las automatizaciones (idea de gh-aw): en un turno que abrió una
// automatización el agente no escribe donde quiera, sólo en las salidas que el tipo declara.
//
// `maintenance` las usa así (abajo, las tareas programadas de la fábrica tienen las suyas): issues nuevos con prefijo `[ghosty]` y etiqueta
// `ghosty-maintenance`, o un PR en BORRADOR desde una rama `ghosty/maint-…`. Nunca mergea,
// nunca cierra, nunca toca ramas de personas.
//
// Lista BLANCA a propósito, como `SOLO_LECTURA` en tools.server.ts: una tool de GitHub nueva
// nace fuera de lo permitido y el olvido falla cerrado.
//
// Puro (sin I/O) para poder probarlo; lo aplica `runTool` y lo usa `listUserTools` para no
// anunciar lo que se va a negar.

export const MAINT_ISSUE_PREFIX = "[ghosty]";
export const MAINT_LABEL = "ghosty-maintenance";
export const MAINT_BRANCH_PREFIX = "ghosty/maint-";

/** Lectura de GitHub: no escribe nada en el repo. `github_checkout` clona a la caja. */
const GITHUB_READ = new Set([
  "github_list_issues",
  "github_get_issue",
  "github_list_prs",
  "github_get_pr",
  "github_pr_files",
  "github_read_file",
  "github_checkout",
  "github_search_code",
  "github_search",
  "github_workflow_runs",
  "github_workflow_run_logs",
  "github_get_workflow_run",
  "github_list_workflows",
  "github_pr_checks",
  "github_repo_tree",
  "github_list_commits",
  "github_get_commit",
  "github_pr_review_comments",
  "github_dependabot_alerts",
  "github_code_scanning_alerts",
  "github_list_branches",
  "github_list_releases",
  "github_get_release",
  "github_list_tags",
  "github_get_tag",
  "github_list_labels",
  "github_get_label",
  "github_list_sub_issues",
  "github_list_issue_types",
  "github_get_me",
]);

/** Escrituras de GitHub permitidas, cada una con su candado de rama/forma abajo. */
const GITHUB_WRITE = new Set([
  "github_create_issue",
  "github_create_branch",
  "github_push_files",
  "github_write_file",
  "github_delete_file",
  "github_create_pr",
]);

/**
 * De la fábrica sólo lo que no publica código: la nota y el contexto. `factory_git_remote`
 * empuja a una rama que esta capa no controla, y `factory_plan_submit` abriría un pedido.
 */
const FACTORY_ALLOWED = new Set(["factory_context", "factory_status", "factory_help", "factory_note", "factory_room"]);

export type SafeOutputsVerdict =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string };

const branchOk = (b: unknown) => typeof b === "string" && b.trim().startsWith(MAINT_BRANCH_PREFIX);

const NOT_HERE =
  "En un turno de mantenimiento sólo puedes abrir issues nuevos o un PR en borrador desde una rama " +
  `${MAINT_BRANCH_PREFIX}…; no mergeas, no cierras ni editas lo de otros. Deja la propuesta como issue o PR borrador.`;

/** ¿Se anuncia esta tool en un turno de mantenimiento? (el candado de verdad es `maintenanceSafeOutputs`). */
export function maintenanceAllows(name: string): boolean {
  if (name.startsWith("github_")) return GITHUB_READ.has(name) || GITHUB_WRITE.has(name);
  if (name.startsWith("factory_") || name.startsWith("alert_webhook_") || name.startsWith("uptime_")) return FACTORY_ALLOWED.has(name);
  // Las demás (chat_*, doc_*, memory_*…) viven dentro de Teams y no tocan el repo.
  return true;
}

/**
 * Decide y, si hace falta, NORMALIZA los argumentos: el prefijo del título, la etiqueta y el
 * borrador los pone la plataforma en vez de pedírselos al modelo (si se le olvidan, igual salen bien).
 */
export function maintenanceSafeOutputs(name: string, args: Record<string, unknown>): SafeOutputsVerdict {
  if (!maintenanceAllows(name)) return { ok: false, error: `${name} no está permitida aquí. ${NOT_HERE}` };
  if (!GITHUB_WRITE.has(name)) return { ok: true, args };
  switch (name) {
    case "github_create_issue": {
      const title = String(args.title ?? "").trim();
      if (!title) return { ok: false, error: "Falta el título del issue." };
      const labels = Array.isArray(args.labels) ? args.labels.map(String) : [];
      return {
        ok: true,
        args: {
          ...args,
          title: title.startsWith(MAINT_ISSUE_PREFIX) ? title : `${MAINT_ISSUE_PREFIX} ${title}`,
          labels: labels.includes(MAINT_LABEL) ? labels : [...labels, MAINT_LABEL],
          // Asignar a una persona la avisaría: eso lo decide quien lea el issue.
          assignees: undefined,
        },
      };
    }
    case "github_create_pr":
      if (!branchOk(args.head))
        return { ok: false, error: `El PR sale de una rama ${MAINT_BRANCH_PREFIX}<receta>-<fecha>; «${String(args.head ?? "")}» no lo es.` };
      return { ok: true, args: { ...args, draft: true } };
    default:
      // create_branch / push_files / write_file / delete_file: sólo en ramas de mantenimiento.
      if (!branchOk(args.branch))
        return { ok: false, error: `Sólo escribes en ramas ${MAINT_BRANCH_PREFIX}<receta>-<fecha>; «${String(args.branch ?? "")}» no lo es.` };
      return { ok: true, args };
  }
}

// ── Tareas programadas de la Software Factory (`apps/factory-schedules.server.ts`) ─────────────
//
// La revisión nocturna y la de dependencias despiertan a @plan con `dest.factorySched`. Su
// salida es UNA: proponer un plan con `factory_plan_submit`, que queda esperando firma humana.
// Lee GitHub para revisar, pero no escribe en el repo (ni issues ni ramas): lo que haya que
// cambiar lo construye @build después de la firma, como cualquier pedido.

export type FactorySchedTask = "nightly" | "deps";

/** Lo de la fábrica que cada tarea puede usar: el contexto, la nota y proponer el plan. */
const FACTORY_SCHED_ALLOWED: Record<FactorySchedTask, Set<string>> = {
  nightly: new Set([...FACTORY_ALLOWED, "factory_plan_submit", "alert_webhook_list", "uptime_list"]),
  deps: new Set([...FACTORY_ALLOWED, "factory_plan_submit"]),
};

const SCHED_NOT_HERE =
  "En una revisión programada de la fábrica sólo lees y, si hay algo accionable, propones UN plan con " +
  "factory_plan_submit (queda esperando firma). No escribes en el repo ni cambias la configuración del room.";

/** ¿Se anuncia esta tool en una tarea programada de la fábrica? */
export function factorySchedAllows(task: FactorySchedTask, name: string): boolean {
  if (name.startsWith("github_")) return GITHUB_READ.has(name);
  if (name.startsWith("factory_") || name.startsWith("alert_webhook_") || name.startsWith("uptime_"))
    return FACTORY_SCHED_ALLOWED[task]?.has(name) ?? false;
  return true;
}

/** El candado de verdad. El plan sale del repo de la tarea: si no lo pasa se le pone, si pasa otro se niega. */
export function factorySchedSafeOutputs(
  task: FactorySchedTask,
  repo: string | undefined,
  name: string,
  args: Record<string, unknown>,
): SafeOutputsVerdict {
  if (!factorySchedAllows(task, name)) return { ok: false, error: `${name} no está permitida aquí. ${SCHED_NOT_HERE}` };
  if (name !== "factory_plan_submit" || !repo) return { ok: true, args };
  const asked = String(args.repo ?? "").trim();
  if (!asked) return { ok: true, args: { ...args, repo } };
  if (asked.toLowerCase() !== repo.toLowerCase())
    return { ok: false, error: `Esta revisión es SÓLO del repo ${repo}; el plan va sobre ése, no sobre ${asked}.` };
  return { ok: true, args };
}
