import { describe, it, expect } from "vitest";
import { ciRedNote, flakyCiNote } from "./factory-fix-hints";
import { approveBriefLead, dependabotBuildHint, flakyLine, forkHelpText, isDependabotUpgrade, prForkOf } from "./factory-runs.server";

// Puestas al día de la fábrica frente a las automatizaciones de GitHub (26-oct).
describe("flaky en el regreso por CI rojo", () => {
  it("sin flaky la nota es la de siempre, byte por byte", () => {
    expect(ciRedNote("unit") + flakyCiNote([])).toBe(ciRedNote("unit"));
  });
  it("con flaky pide reintentar primero y liga el issue", () => {
    const t = flakyCiNote([{ workflow: "Tests", count: 3, windowDays: 14, issueUrl: "https://github.com/o/r/issues/12" }]);
    expect(t).toContain("«Tests» (3 vez/veces en 14 días) · issue agrupado https://github.com/o/r/issues/12");
    expect(t).toContain("github_rerun_workflow");
    expect(flakyLine([{ workflow: "Tests", count: 3, windowDays: 14, issueUrl: null }, { workflow: "E2E", count: 1, windowDays: 14, issueUrl: null }])).toBe(
      "«Tests» (y 1 más) ya está marcado flaky en este repo.",
    );
  });
});

describe("forks", () => {
  it("prForkOf: otro repo = fork; mismo repo (sin importar mayúsculas) o sin dato, no", () => {
    expect(prForkOf("https://github.com/o/r/pull/8", "ana/r")).toBe("ana/r");
    expect(prForkOf("https://github.com/o/r/pull/8", "O/R")).toBeNull();
    expect(prForkOf("https://github.com/o/r/pull/8", null)).toBeNull();
  });
  it("el aviso dice que la App no puede empujar", () => {
    expect(forkHelpText("ci_red", "https://github.com/o/r/pull/8", "ana/r", "unit")).toContain("viene de un fork (`ana/r`)");
  });
});

describe("dep_fix sobre un PR de Dependabot no adoptado", () => {
  const depFix = { kind: "dep_fix", branch: "dependabot/npm_and_yarn/vite-6.0.0", prUrl: "https://github.com/o/r/pull/3" };
  it("cuenta como subida de Dependabot y recibe el encargo de los hermanos", () => {
    expect(isDependabotUpgrade(depFix)).toBe(true);
    expect(dependabotBuildHint(depFix)).toBe(dependabotBuildHint({ kind: "dependabot" }));
    expect(approveBriefLead(depFix, { who: "Ana", version: 1, again: true })).toContain(".github/dependabot.yml");
  });
  it("Renovate o un ci_fix normal, no", () => {
    expect(isDependabotUpgrade({ kind: "dep_fix", branch: "renovate/vite-6.x" })).toBe(false);
    expect(isDependabotUpgrade({ kind: "ci_fix", branch: "dependabot/npm/x" })).toBe(false);
    expect(dependabotBuildHint({ kind: null })).toBe("");
  });
  it("un pedido normal no cambia", () => {
    expect(approveBriefLead({ kind: null, branch: null, prUrl: null }, { who: "Ana", version: 2, again: false })).toBe(
      "Ana aprobó el plan v2. Constrúyelo: rama nueva, código, pruebas, PR en BORRADOR, y cierra con factory_build_done.",
    );
  });
});
