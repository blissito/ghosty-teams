import { describe, it, expect } from "vitest";
import { deployVerdict, smokeVerdict, type WorkflowRun } from "./post-merge.server";

const run = (name: string, status: string, conclusion: string | null = null): WorkflowRun => ({
  name,
  status,
  conclusion,
  html_url: `https://github.com/o/r/actions/runs/${name}`,
});

describe("deployVerdict", () => {
  it("mientras un workflow corre, se espera", () => {
    expect(deployVerdict([run("Fly Deploy", "in_progress")], 60)).toEqual({ kind: "running" });
    expect(deployVerdict([run("Fly Deploy", "queued"), run("Tests", "completed", "success")], 60)).toEqual({ kind: "running" });
  });

  it("todo verde", () => {
    expect(deployVerdict([run("Fly Deploy", "completed", "success"), run("Lint", "completed", "skipped")], 300)).toEqual({ kind: "green" });
  });

  it("uno falla y lo dice aunque otro siga corriendo", () => {
    const v = deployVerdict([run("Tests", "in_progress"), run("Fly Deploy", "completed", "failure")], 120);
    expect(v).toMatchObject({ kind: "failed", name: "Fly Deploy", conclusion: "failure" });
    expect(deployVerdict([run("Fly Deploy", "completed", "cancelled")], 120)).toMatchObject({ kind: "failed", conclusion: "cancelled" });
  });

  it("sin workflows: espera la gracia de 3 min y luego sólo smoke", () => {
    expect(deployVerdict([], 60)).toEqual({ kind: "running" });
    expect(deployVerdict([], 180)).toEqual({ kind: "none" });
  });

  it("tope de 30 min corriendo", () => {
    expect(deployVerdict([run("Fly Deploy", "in_progress")], 30 * 60)).toMatchObject({ kind: "timeout", name: "Fly Deploy" });
  });
});

describe("smokeVerdict", () => {
  it("200 pasa", () => {
    expect(smokeVerdict("https://denik.me/", { status: 200 })).toBeNull();
  });
  it("404 en la raíz falla; en otra ruta no", () => {
    expect(smokeVerdict("https://denik.me/", { status: 404 })).toBe("HTTP 404");
    expect(smokeVerdict("https://denik.me/planes", { status: 404 })).toBeNull();
  });
  it("5xx falla", () => {
    expect(smokeVerdict("https://denik.me/planes", { status: 502 })).toBe("HTTP 502");
  });
  it("timeout falla con su motivo", () => {
    expect(smokeVerdict("https://denik.me/", { error: "no contestó en 15 s" })).toBe("no contestó en 15 s");
  });
});
