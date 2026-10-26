import { describe, expect, it } from "vitest";
import { automationGroupSuffix, budgetDay, eventMatches, isGhostyBot, pickAutomations, prNumbersOf } from "./dispatch";
import type { Automation, AutomationKind, RepoEvent } from "./types";

const ev = (over: Partial<RepoEvent> = {}): RepoEvent => ({ deliveryId: "d", event: "workflow_run", action: "completed", repo: "acme/app", sender: { login: "ana", type: "User" }, ...over });
const auto = (kind: AutomationKind, on: string[], extra: Partial<Automation> = {}): Automation => ({ kind, on, handle: async () => {}, ...extra });

describe("despachador de automatizaciones", () => {
  it("`on` acepta el evento solo o evento.acción", () => {
    expect(eventMatches(["workflow_run"], ev())).toBe(true);
    expect(eventMatches(["workflow_run.completed"], ev())).toBe(true);
    expect(eventMatches(["workflow_run.requested"], ev())).toBe(false);
    expect(eventMatches(["issues.opened"], ev({ event: "issues", action: "opened" }))).toBe(true);
    expect(eventMatches(["issues.opened"], ev({ event: "issues", action: undefined }))).toBe(false);
    expect(eventMatches([], ev())).toBe(false);
  });

  it("sólo corre lo prendido en el room y que escucha ese evento", () => {
    const all = [auto("ci_fix", ["workflow_run.completed"]), auto("ci_doctor", ["workflow_run"]), auto("issue_triage", ["issues.opened"])];
    const picked = pickAutomations(all, new Set<AutomationKind>(["ci_fix", "issue_triage"]), ev());
    expect(picked.map((a) => a.kind)).toEqual(["ci_fix"]);
    expect(pickAutomations(all, new Set(), ev())).toEqual([]);
  });

  it("anti-bucle: lo que causó nuestro bot no despierta nada, salvo quien lo pide", () => {
    expect(isGhostyBot("ghosty-studio[bot]")).toBe(true);
    expect(isGhostyBot("Ghosty[bot]")).toBe(true);
    expect(isGhostyBot("dependabot[bot]")).toBe(false);
    expect(isGhostyBot(undefined)).toBe(false);
    const all = [auto("ci_fix", ["workflow_run"]), auto("ci_doctor", ["workflow_run"], { allowGhostyBot: true })];
    const byBot = ev({ sender: { login: "ghosty-studio[bot]", type: "Bot" } });
    expect(pickAutomations(all, new Set<AutomationKind>(["ci_fix", "ci_doctor"]), byBot).map((a) => a.kind)).toEqual(["ci_doctor"]);
    // Otros bots (dependabot) sí cuentan: dep_fix vive de ellos.
    const byDependabot = ev({ sender: { login: "dependabot[bot]", type: "Bot" } });
    expect(pickAutomations(all, new Set<AutomationKind>(["ci_fix"]), byDependabot)).toHaveLength(1);
  });

  it("PRs del evento: el del PR y los del run, sin repetir", () => {
    expect(prNumbersOf(ev({ pr: { number: 3 }, run: { id: 1, prNumbers: [3, 4] } }))).toEqual([3, 4]);
    expect(prNumbersOf(ev({ event: "issues", issue: { number: 9 } }))).toEqual([]);
  });

  it("el tope diario se renueva a medianoche de CDMX", () => {
    expect(budgetDay(Date.UTC(2026, 9, 25, 5, 59))).toBe("2026-10-24");
    expect(budgetDay(Date.UTC(2026, 9, 25, 6, 0))).toBe("2026-10-25");
  });

  it("la conversación del hilo es estable por threadKey y sin caracteres raros", () => {
    expect(automationGroupSuffix("tech", "ci_fix:Acme/App#12")).toBe("tech-auto-ci-fix-acme-app-12");
    expect(automationGroupSuffix("tech", "ci_fix:Acme/App#12")).toBe(automationGroupSuffix("tech", "ci_fix:acme/app#12"));
  });
});
