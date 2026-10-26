import { describe, expect, it } from "vitest";
import { classifyRun, flakyIssueBody, shouldDiagnose, type CiRunRow } from "./ci-doctor.server";
import type { RepoEvent } from "./types";

const row = (o: Partial<CiRunRow>): CiRunRow => ({ workflow: "CI", headSha: "abc", runId: 10, attempt: 1, conclusion: "failure", ...o });

describe("classifyRun", () => {
  it("re-run del mismo run: falló el 1 y pasó el 2 → flaky", () => {
    expect(classifyRun([row({})], row({ attempt: 2, conclusion: "success" }))).toBe("flaky");
  });
  it("otro run con el mismo sha que pasa después de uno rojo → flaky", () => {
    expect(classifyRun([row({ runId: 10 })], row({ runId: 11, conclusion: "success" }))).toBe("flaky");
  });
  it("verde sin rojo previo, o rojo con otro sha/workflow → success", () => {
    expect(classifyRun([], row({ conclusion: "success" }))).toBe("success");
    expect(classifyRun([row({ headSha: "zzz" })], row({ runId: 11, conclusion: "success" }))).toBe("success");
    expect(classifyRun([row({ workflow: "Lint" })], row({ runId: 11, conclusion: "success" }))).toBe("success");
  });
  it("el rojo POSTERIOR no hace flaky al verde (pasó y luego falló no cuenta)", () => {
    expect(classifyRun([row({ runId: 12 })], row({ runId: 11, conclusion: "success" }))).toBe("success");
  });
  it("un sha ya marcado flaky no se cuenta dos veces", () => {
    const h = [row({}), row({ attempt: 2, conclusion: "success", flaky: true })];
    expect(classifyRun(h, row({ attempt: 3, conclusion: "success" }))).toBe("success");
  });
  it("rojos y lo que no es verde ni rojo", () => {
    expect(classifyRun([], row({ conclusion: "timed_out" }))).toBe("failure");
    expect(classifyRun([row({})], row({ attempt: 2, conclusion: "cancelled" }))).toBe("ignore");
    expect(classifyRun([], row({ conclusion: "skipped" }))).toBe("ignore");
  });
});

const ev = (run: Partial<NonNullable<RepoEvent["run"]>>, sender = "bliss"): RepoEvent => ({
  deliveryId: "d", event: "workflow_run", action: "completed", repo: "o/r", sender: { login: sender },
  run: { id: 1, name: "CI", conclusion: "failure", headSha: "abc", headBranch: "main", event: "push", ...run },
});

describe("shouldDiagnose", () => {
  it("rojo por push en la rama principal → sí", () => {
    expect(shouldDiagnose(ev({}), ["main"])).toBe(true);
  });
  it("lo de un PR es de ci_fix", () => {
    expect(shouldDiagnose(ev({ prNumbers: [4] }), ["main"])).toBe(false);
    expect(shouldDiagnose(ev({ event: "pull_request" }), ["main"])).toBe(false);
  });
  it("otra rama, verde, o causado por nuestro bot → no", () => {
    expect(shouldDiagnose(ev({ headBranch: "feat/x" }), ["main"])).toBe(false);
    expect(shouldDiagnose(ev({ conclusion: "success" }), ["main"])).toBe(false);
    expect(shouldDiagnose(ev({}, "ghosty-studio[bot]"), ["main"])).toBe(false);
    expect(shouldDiagnose(ev({}, "dependabot[bot]"), ["main"])).toBe(true);
  });
});

describe("flakyIssueBody", () => {
  it("lleva una liga por run, el más reciente arriba", () => {
    const b = flakyIssueBody("o/r", "CI", [
      row({ runId: 1, attempt: 2, at: 100, url: "https://x/1" }),
      row({ runId: 2, attempt: 2, at: 200 }),
    ], 14);
    expect(b).toContain("[run 1](https://x/1)");
    expect(b).toContain("https://github.com/o/r/actions/runs/2");
    expect(b.indexOf("run 2")).toBeLessThan(b.indexOf("run 1"));
  });
});
