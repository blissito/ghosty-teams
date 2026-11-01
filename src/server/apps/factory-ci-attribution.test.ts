import { describe, it, expect } from "vitest";
import { allRedForeign, ciAttribution, foreignRedLine } from "./factory-ci-attribution";
import { ciSignal } from "./factory-repo-alerts.server";
import { needsYou, normalizeEscalationOptions, viewState } from "./factory-flow";

// Casos reales de MailMask (1-nov). #153: `security` (gitleaks sin permiso tras volver privado el
// repo) rojo en el PR, ausente en main (sólo corre en PRs) y rojo también en #124. #154: 10 jobs
// rojos en 2–3 s por un cobro de GitHub.
const ok = (name: string, seconds = 60) => ({ name, state: "success", seconds });
const red = (name: string, seconds = 40) => ({ name, state: "failure", seconds });

describe("¿de quién es el rojo?", () => {
  it("#153: security rojo en este PR y en otros dos, ausente en main → de todo el repo", () => {
    const reds = ciAttribution([ok("quick"), red("security", 12)], [ok("quick"), ok("deploy")], [[red("security", 11)], [red("security", 9), ok("quick")]]);
    expect(reds).toEqual([{ name: "security", origin: "repo_wide" }]);
    expect(allRedForeign(reds)).toBe(true);
    expect(foreignRedLine(reds)).toContain("otros PRs");
  });

  it("#154: todo rojo en ≤ 5 s → GitHub no lo arrancó", () => {
    const reds = ciAttribution([red("quick", 3), red("verify (1)", 2), red("docker", 3)], null, []);
    expect(reds.every((r) => r.origin === "not_started")).toBe(true);
  });

  it("rojo también en main → base", () => {
    expect(ciAttribution([red("test")], [red("test", 80)], [])[0].origin).toBe("base");
  });

  it("un rojo propio sigue siendo del PR (un solo hermano no alcanza)", () => {
    const reds = ciAttribution([red("test"), red("security")], [ok("test")], [[red("security")]]);
    expect(reds.map((r) => r.origin)).toEqual(["pr", "pr"]);
    expect(allRedForeign(reds)).toBe(false);
    expect(foreignRedLine(reds)).toBe("");
  });

  it("sin rojos no hay nada ajeno", () => {
    expect(allRedForeign(ciAttribution([ok("a")], null, []))).toBe(false);
  });
});

describe("aviso por repo: GitHub no arranca los jobs", () => {
  it("rojo en segundos = abajo; un check que corre de verdad = arriba; corriendo = sin señal", () => {
    expect(ciSignal([red("quick", 3), red("docker", 2)])).toBe("down");
    expect(ciSignal([ok("quick", 40)])).toBe("up");
    expect(ciSignal([red("quick", 30)])).toBe("up");
    expect(ciSignal([{ name: "x", state: "pending", seconds: null }])).toBeNull();
  });
});

describe("esperando el arreglo de main", () => {
  const run = { status: "escalated" as const, requestedBy: "ana" };
  const opts = { lastActivityAt: 0, now: 100, busy: false };
  it("no le toca a la persona y la tarjeta dice qué espera", () => {
    expect(needsYou(run, { kind: "decision", waitingFix: 200 })).toBe(false);
    expect(needsYou(run, { kind: "decision" })).toBe(true);
    const v = viewState(run, { ...opts, escalationKind: "decision", waitingFix: 200 });
    expect(v.label).toBe("Esperando el arreglo de main (#200)");
    expect(v.whoseTurn).toBeNull();
  });

  it("fix_main es una opción válida sólo con PR", () => {
    const o = [{ label: "Arreglar main", action: "fix_main", brief: "b" }, { label: "Así", action: "merge_as_is", brief: "c" }, { label: "Rama", action: "build", brief: "d" }];
    expect(normalizeEscalationOptions(o, { hasPr: true })!.map((x) => x.action)).toEqual(["fix_main", "merge_as_is", "build"]);
    expect(normalizeEscalationOptions(o, { hasPr: false })).toBeNull();
  });
});
