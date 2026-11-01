// ¿De quién es el rojo? (1-nov, MailMask #153/#154).
//
// Antes de culpar al PR, la plataforma mira si lo mismo truena fuera de él: es lo que hacen
// Chromium («retry without patch»), Trunk (`ignoreBaseFailures`) y Mergify (re-correr en la rama
// principal). Sin esto @check diagnosticaba bien un 403 de gitleaks en main y la fábrica igual
// regresaba el PR a @build, que no podía arreglarlo. Puro: sin red, para probarlo con los runs reales.
//
// - `not_started`: GitHub no corrió el job (rojo en ≤ 5 s: cobro o límite de gasto).
// - `base`: el mismo check está rojo en la cabeza de la rama base.
// - `repo_wide`: el mismo check está rojo en ≥ 2 PRs de OTROS pedidos abiertos del repo. Cubre los
//   jobs que sólo corren en PRs (`security` con `if: pull_request`), que en main ni aparecen.
// - `pr`: lo demás; ése sí es del PR.

export type RedOrigin = "pr" | "base" | "repo_wide" | "not_started";
export type CheckLite = { name: string; state: string; seconds: number | null };
export type RedCheck = { name: string; origin: RedOrigin };

/** Rojo en ≤ 5 s: ningún job real de Actions termina tan rápido (sólo preparar el runner tarda más). */
export const NOT_STARTED_MAX_S = 5;
/** PRs hermanos con el mismo check rojo para llamarlo «de todo el repo». */
export const REPO_WIDE_MIN = 2;

export function ciAttribution(pr: CheckLite[], base: CheckLite[] | null, siblings: CheckLite[][]): RedCheck[] {
  const redIn = (list: CheckLite[] | null | undefined, name: string) => !!list?.some((c) => c.name === name && c.state === "failure");
  return pr
    .filter((c) => c.state === "failure")
    .map((c) => {
      if (c.seconds !== null && c.seconds <= NOT_STARTED_MAX_S) return { name: c.name, origin: "not_started" as const };
      if (redIn(base, c.name)) return { name: c.name, origin: "base" as const };
      if (siblings.filter((s) => redIn(s, c.name)).length >= REPO_WIDE_MIN) return { name: c.name, origin: "repo_wide" as const };
      return { name: c.name, origin: "pr" as const };
    });
}

/** ¿Todo lo rojo es ajeno al PR? (false si no hay rojos). */
export function allRedForeign(reds: RedCheck[]): boolean {
  return reds.length > 0 && reds.every((r) => r.origin !== "pr");
}

/** Un renglón para el encargo de @check y la tarjeta: qué está rojo y por qué no es del PR. Vacío si nada es ajeno. */
export function foreignRedLine(reds: RedCheck[]): string {
  const why: Record<Exclude<RedOrigin, "pr">, string> = {
    not_started: "GitHub no lo arrancó (cobro o límite de gasto)",
    base: "también está rojo en la rama principal",
    repo_wide: "está rojo en otros PRs del repo",
  };
  const foreign = reds.filter((r) => r.origin !== "pr");
  if (!foreign.length) return "";
  return foreign.map((r) => `\`${r.name}\`: ${why[r.origin as Exclude<RedOrigin, "pr">]}`).join("; ");
}
