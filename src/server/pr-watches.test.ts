import { describe, it, expect } from "vitest";
import { duePoll, prWatchTargets } from "./pr-watches.server";

describe("vigilancias de PR por evento", () => {
  it("CI terminado: los PRs ligados al run; sin PR (forks) todo el repo", () => {
    expect(prWatchTargets({ event: "workflow_run", action: "completed", repo: "o/r", run: { prNumbers: [8] } })).toEqual({ repo: "o/r", numbers: [8] });
    expect(prWatchTargets({ event: "workflow_run", action: "completed", repo: "o/r", run: { prNumbers: [] } })).toEqual({ repo: "o/r", numbers: null });
    expect(prWatchTargets({ event: "workflow_run", action: "requested", repo: "o/r" })).toBeNull();
  });
  it("push nuevo, merge o cierre del PR: ese PR; lo demás, nada", () => {
    expect(prWatchTargets({ event: "pull_request", action: "synchronize", repo: "o/r", pr: { number: 8 } })).toEqual({ repo: "o/r", numbers: [8] });
    expect(prWatchTargets({ event: "pull_request", action: "closed", repo: "o/r", pr: { number: 8 } })?.numbers).toEqual([8]);
    expect(prWatchTargets({ event: "pull_request", action: "labeled", repo: "o/r", pr: { number: 8 } })).toBeNull();
    expect(prWatchTargets({ event: "issues", action: "opened", repo: "o/r" })).toBeNull();
  });
  it("sondeo de respaldo: 2 min sin eventos del repo, 10 min con eventos frescos", () => {
    const now = 1_000_000_000;
    expect(duePoll(now, undefined, now)).toBe(true);
    expect(duePoll(now, now - 3 * 60_000, undefined)).toBe(true);
    expect(duePoll(now, now - 3 * 60_000, now - 60_000)).toBe(false);
    expect(duePoll(now, now - 11 * 60_000, now - 60_000)).toBe(true);
    // Eventos viejos (más de 30 min): vuelve el sondeo de 2 min.
    expect(duePoll(now, now - 3 * 60_000, now - 40 * 60_000)).toBe(true);
  });
});
