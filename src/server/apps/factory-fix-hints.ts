// ── Lo que la fábrica ya aprendió sobre arreglar un PR, compartido ──────────────────────────
//
// Textos que van en los encargos a @build. Nacieron en la Software Factory (rol @build,
// `onPrCiRed`, `onPrConflict`) y los reusan tal cual las automatizaciones de PR
// (`automations/pr-fix.server.ts`), que despiertan a @build sobre PRs que no son de un pedido.
// Puro, sin imports: lo cargan `factory-roles.ts` y `factory-runs.server.ts`.

/**
 * Cómo se resuelve un PR con conflictos. Va en todo encargo a @build que lo necesite: el de
 * `onPrConflict` y el regreso de @check. Sin él, @build copiaba los archivos de la principal
 * encima SIN commit de merge y GitHub seguía marcando choques (PR #8 de palmera-legal, 3-oct).
 */
export const MERGE_FROM_HINT =
  "Fusiona la rama principal en la tuya con github_push_files y `mergeFrom` = la rama principal: es un commit de MERGE de verdad (dos padres). " +
  "Lo que cambió allá y tú no tocaste entra solo, y en `files` va el contenido final de los archivos que chocan (resuélvelos SIN cambiar el alcance del plan). " +
  "Copiar los archivos de la principal sin `mergeFrom` NO quita los conflictos: GitHub mira la historia, no el contenido.";

/** El regreso a @build cuando el CI de su PR sale rojo (`onPrCiRed`). */
export function ciRedNote(what: string): string {
  return `El CI del PR falló (${what}). Lee el log con github_workflow_run_logs, corrígelo en la misma rama y no cierres hasta verlo en verde.`;
}

/** Rojo en un PR de Dependabot: primero saber si viene de main o de la subida misma. */
export const DEP_RED_FROM_MAIN_HINT = "Mira si el mismo check truena en main (entonces no es la subida)";

/** Dónde corre @build lo del repo (rol @build, paso 2). */
export const WORK_BOX_HINT =
  "Para correr lo del repo (npm, pruebas, lint, typecheck) usa una caja de trabajo: skill dev-test, `ensure()`/`execLong()` de /opt/gs-sdk/sandbox.mjs, con `node` desde tu workspace. Su URL NO aparece en tu shell (`echo $GS_BOX_URL` sale vacío y no significa nada): pídela con el SDK, y sólo si falla di que no hay caja, citando el error literal.";

/** Un CI que falló por algo pasajero se reintenta en vez de tocar código (rol @build). */
export const RERUN_HINT = "github_rerun_workflow (reintenta un CI que falló por algo pasajero)";

