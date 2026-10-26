import { describe, expect, it } from "vitest";
import { dueJobs, dueSlot, isDue, parseCron, recipeText, recipesOf } from "./maintenance.server";
import { maintenanceAllows, maintenanceSafeOutputs } from "./safe-outputs";

// Lunes 26-oct-2026 09:00 en CDMX = 15:00 UTC (UTC−6 fijo, sin horario de verano).
const MON_9_CDMX = Date.UTC(2026, 9, 26, 15, 0);
const min = 60_000;

describe("isDue (reloj de CDMX)", () => {
  it("default = lunes 9:00 CDMX", () => {
    expect(isDue({}, MON_9_CDMX)).toBe(true);
    expect(dueSlot({}, MON_9_CDMX)).toBe("2026-10-26");
  });

  it("no antes de la hora ni pasada la ventana de 60 min", () => {
    expect(isDue({}, MON_9_CDMX - min)).toBe(false);
    expect(isDue({}, MON_9_CDMX + 59 * min)).toBe(true);
    expect(isDue({}, MON_9_CDMX + 60 * min)).toBe(false);
  });

  it("9:00 UTC no es 9:00 CDMX", () => {
    expect(isDue({}, Date.UTC(2026, 9, 26, 9, 0))).toBe(false);
  });

  it("la fecha del slot es la de CDMX, no la de UTC", () => {
    // Domingo 25-oct 23:30 CDMX = lunes 26-oct 05:30 UTC.
    const now = Date.UTC(2026, 9, 26, 5, 30);
    expect(dueSlot({ weekday: 0, hour: 23, minute: 30 }, now)).toBe("2026-10-25");
    expect(isDue({ weekday: 1, hour: 5, minute: 30 }, now)).toBe(false);
  });

  it("weekday/hour propios", () => {
    // Viernes 30-oct 18:00 CDMX = sábado 00:00 UTC.
    expect(isDue({ weekday: 5, hour: 18 }, Date.UTC(2026, 9, 31, 0, 0))).toBe(true);
    expect(isDue({ weekday: 5, hour: 18 }, MON_9_CDMX)).toBe(false);
  });

  it("cron en hora de CDMX gana sobre weekday/hour", () => {
    expect(isDue({ cron: "0 9 * * 1-5", weekday: 3 }, MON_9_CDMX)).toBe(true);
    expect(isDue({ cron: "30 7 * * *" }, Date.UTC(2026, 9, 27, 13, 30))).toBe(true);
    expect(isDue({ cron: "0 9 1 * *" }, MON_9_CDMX)).toBe(false);
  });

  it("ajustes inválidos nunca disparan", () => {
    expect(isDue({ cron: "basura" }, MON_9_CDMX)).toBe(false);
    expect(isDue({ cron: "0 25 * * *" }, MON_9_CDMX)).toBe(false);
    expect(isDue({ hour: 9.5 }, MON_9_CDMX)).toBe(false);
  });
});

describe("parseCron", () => {
  it("listas, rangos, pasos y domingo = 7", () => {
    const c = parseCron("*/15 9-10 * * 7")!;
    expect([...c.minute]).toEqual([0, 15, 30, 45]);
    expect([...c.hour]).toEqual([9, 10]);
    expect([...c.dow]).toEqual([0]);
  });
});

describe("dueJobs", () => {
  const row = { roomId: 7, repo: "acme/web", settings: { recipes: ["deps", "todos", "inventada", "deps"] }, ownerSub: "u1", origin: "https://x" };

  it("una tarea por receta conocida, con la llave del claim por fecha", () => {
    const jobs = dueJobs([row], MON_9_CDMX);
    expect(jobs.map((j) => [j.recipe, j.handle, j.key])).toEqual([
      ["deps", "build", "sched:maint:7:acme/web:deps:2026-10-26"],
      ["todos", "plan", "sched:maint:7:acme/web:todos:2026-10-26"],
    ]);
  });

  it("dos ticks dentro de la ventana dan la MISMA llave (un solo disparo)", () => {
    const a = dueJobs([row], MON_9_CDMX).map((j) => j.key);
    const b = dueJobs([row], MON_9_CDMX + 15 * min).map((j) => j.key);
    expect(b).toEqual(a);
  });

  it("sin recetas o fuera de hora no hay nada", () => {
    expect(dueJobs([{ ...row, settings: {} }], MON_9_CDMX)).toEqual([]);
    expect(dueJobs([row], MON_9_CDMX - min)).toEqual([]);
  });

  it("recipesOf filtra y deduplica", () => {
    expect(recipesOf({ recipes: ["tests", "docs", "tests", "x"] })).toEqual(["tests", "docs"]);
  });
});

describe("recipeText", () => {
  it("dice los safe-outputs y la rama de la receta", () => {
    const t = recipeText("deps", "acme/web", "2026-10-26");
    expect(t).toContain("ghosty/maint-deps-2026-10-26");
    expect(t).toContain("BORRADOR");
    expect(t).toContain("Nunca mergeas");
    expect(recipeText("todos", "acme/web", "2026-10-26")).toContain("ghosty-maintenance");
  });
});

describe("safe-outputs de mantenimiento", () => {
  it("niega merge, cerrar, editar, comentar y lo que no conoce", () => {
    for (const n of ["github_merge_pr", "github_update_issue", "github_update_pr", "github_comment", "github_enable_auto_merge", "github_delete_repo", "github_algo_nuevo", "factory_git_remote", "factory_plan_submit"]) {
      expect(maintenanceAllows(n)).toBe(false);
      expect(maintenanceSafeOutputs(n, {}).ok).toBe(false);
    }
  });

  it("deja leer y las tools que no tocan el repo", () => {
    for (const n of ["github_read_file", "github_search_code", "chat_history", "factory_note"]) expect(maintenanceAllows(n)).toBe(true);
  });

  it("el issue sale con prefijo y etiqueta aunque el modelo los olvide", () => {
    const v = maintenanceSafeOutputs("github_create_issue", { repo: "a/b", title: "TODO en auth", labels: ["bug"] });
    expect(v).toEqual({ ok: true, args: { repo: "a/b", title: "[ghosty] TODO en auth", labels: ["bug", "ghosty-maintenance"], assignees: undefined } });
    const w = maintenanceSafeOutputs("github_create_issue", { repo: "a/b", title: "[ghosty] ya", labels: ["ghosty-maintenance"] });
    expect(w.ok && w.args.title).toBe("[ghosty] ya");
    expect(w.ok && w.args.labels).toEqual(["ghosty-maintenance"]);
  });

  it("el PR sale en borrador y sólo desde ghosty/maint-*", () => {
    expect(maintenanceSafeOutputs("github_create_pr", { head: "ghosty/maint-deps-2026-10-26", draft: false })).toEqual({
      ok: true,
      args: { head: "ghosty/maint-deps-2026-10-26", draft: true },
    });
    expect(maintenanceSafeOutputs("github_create_pr", { head: "feature/x" }).ok).toBe(false);
  });

  it("commits y ramas sólo en ghosty/maint-*", () => {
    for (const n of ["github_push_files", "github_write_file", "github_delete_file", "github_create_branch"]) {
      expect(maintenanceSafeOutputs(n, { branch: "ghosty/maint-docs-2026-10-26" }).ok).toBe(true);
      expect(maintenanceSafeOutputs(n, { branch: "main" }).ok).toBe(false);
      expect(maintenanceSafeOutputs(n, {}).ok).toBe(false);
    }
  });
});
