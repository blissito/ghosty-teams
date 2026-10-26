import { describe, expect, it } from "vitest";
import { factorySchedAllows, factorySchedSafeOutputs } from "./safe-outputs";

describe("safe-outputs de las tareas programadas de la fábrica", () => {
  it("lee GitHub pero no escribe en el repo", () => {
    expect(factorySchedAllows("nightly", "github_workflow_runs")).toBe(true);
    expect(factorySchedAllows("deps", "github_read_file")).toBe(true);
    for (const t of ["github_create_issue", "github_create_pr", "github_push_files", "github_merge_pr", "github_tool_nueva"])
      expect(factorySchedAllows("nightly", t)).toBe(false);
  });

  it("propone el plan con firma; nada de construir ni de cambiar el room", () => {
    expect(factorySchedAllows("nightly", "factory_plan_submit")).toBe(true);
    expect(factorySchedAllows("deps", "factory_plan_submit")).toBe(true);
    expect(factorySchedAllows("nightly", "factory_context")).toBe(true);
    for (const t of ["factory_build_done", "factory_git_remote", "factory_close", "alert_webhook_create", "uptime_add"])
      expect(factorySchedAllows("nightly", t)).toBe(false);
    expect(factorySchedAllows("nightly", "uptime_list")).toBe(true);
    expect(factorySchedAllows("deps", "uptime_list")).toBe(false);
    // Lo que vive dentro de Teams sigue.
    expect(factorySchedAllows("deps", "chat_post")).toBe(true);
  });

  it("el plan sale del repo de la tarea", () => {
    expect(factorySchedSafeOutputs("deps", "acme/api", "factory_plan_submit", { title: "x" })).toEqual({ ok: true, args: { title: "x", repo: "acme/api" } });
    expect(factorySchedSafeOutputs("deps", "acme/api", "factory_plan_submit", { repo: "ACME/api" }).ok).toBe(true);
    expect(factorySchedSafeOutputs("deps", "acme/api", "factory_plan_submit", { repo: "acme/web" }).ok).toBe(false);
    expect(factorySchedSafeOutputs("nightly", "acme/api", "github_create_issue", {}).ok).toBe(false);
  });
});
