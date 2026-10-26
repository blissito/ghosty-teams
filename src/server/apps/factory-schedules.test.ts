import { describe, it, expect, vi, beforeEach } from "vitest";

let cfg: Record<string, unknown> | null = null;
let due: Record<string, unknown>[] = [];
let claimOk = true;
const wakes: { key: string; text?: string; ref?: unknown }[] = [];
let roomRepos: string[] = [];
let repoRows: Record<string, unknown>[] = [];
let spaceRows: Record<string, unknown>[] = [];

vi.mock("../../db.server", () => ({ listRoomRepos: async () => roomRepos.map((repo) => ({ repo, connectedBy: "u_gh" })) }));
vi.mock("./installed.server", () => ({ getAppConfig: async () => cfg, isInstalled: async () => !!cfg }));
vi.mock("./factory", () => ({ factoryRoomIds: async () => (cfg ? [12] : []) }));
vi.mock("../tenant.server", () => ({ withNamespace: (_ns: string, fn: () => unknown) => fn() }));
vi.mock("../../dbq.server", () => ({
  dbq: async (sql: string) => {
    if (sql.startsWith("SELECT * FROM gt_factory_schedules WHERE enabled")) return due;
    if (sql.startsWith("UPDATE gt_factory_schedules SET next_at")) return claimOk ? [{ kind: "nightly" }] : [];
    if (sql.startsWith("SELECT * FROM gt_factory_repo_schedules")) return repoRows;
    if (sql.startsWith("SELECT * FROM gt_factory_schedules")) return spaceRows;
    return [];
  },
}));
vi.mock("../../agents.server", () => ({
  resolvedAgents: async () => [{ handle: "plan", name: "Plan", avatar: "" }],
  agentGroupId: async () => "g",
}));
vi.mock("../wakeups.server", () => ({
  enqueueWakeup: async (w: { key: string }) => {
    wakes.push(w);
    return true;
  },
  mintWakeRef: (r: unknown) => r,
  armWakeups: () => {},
}));

import { defaultCron, dueRepoJobs, factoryDepsCoverage, sweepTenant, type RepoSchedule } from "./factory-schedules.server";

const row = { kind: "nightly", enabled: 1, hour: 2, weekdays_only: 1, tz: "America/Mexico_City", next_at: 1, owner_sub: "u1" };

describe("sweep de tareas programadas", () => {
  beforeEach(() => {
    cfg = null;
    due = [row];
    claimOk = true;
    wakes.length = 0;
    roomRepos = [];
    repoRows = [];
    spaceRows = [];
  });

  it("con varios repos: un despertar por repo, y el encargo nombra el suyo", async () => {
    cfg = { roomId: 12 };
    roomRepos = ["acme/web", "acme/api"];
    await sweepTenant("ns");
    expect(wakes.map((w) => w.key)).toEqual([
      expect.stringMatching(/^sched:factory-nightly:12:acme\/web:/),
      expect.stringMatching(/^sched:factory-nightly:12:acme\/api:/),
    ]);
    expect(wakes[1].text).toContain("SÓLO sobre el repo acme/api");
  });

  it("sin la fábrica instalada no despierta a nadie", async () => {
    await sweepTenant("ns");
    expect(wakes).toHaveLength(0);
  });

  it("con la fábrica despierta a @plan con llave sched: (la del OK sin burbuja)", async () => {
    cfg = { roomId: 12 };
    roomRepos = ["acme/web"];
    await sweepTenant("ns");
    expect(wakes).toHaveLength(1);
    expect(wakes[0].key).toMatch(/^sched:factory-nightly:/);
  });

  it("si otro tick ya la reclamó, no dispara dos veces", async () => {
    cfg = { roomId: 12 };
    roomRepos = ["acme/web"];
    claimOk = false;
    await sweepTenant("ns");
    expect(wakes).toHaveLength(0);
  });
});

// Lunes 26-oct-2026 09:10 CDMX (UTC−6) = 15:10 UTC.
const MON_0910 = Date.UTC(2026, 9, 26, 15, 10);
const repoRow = (o: Partial<Record<string, unknown>> = {}) => ({
  room_id: 12, repo: "acme/api", kind: "nightly", enabled: 1, cron: "0 9 * * 1", owner_sub: "u2", origin: "https://o", ...o,
});
const rs = (o: Partial<RepoSchedule> = {}): RepoSchedule => ({
  roomId: 12, repo: "acme/api", kind: "nightly", enabled: true, cron: "0 9 * * 1", ownerSub: "u2", origin: "https://o", ...o,
});

describe("tareas por room+repo", () => {
  beforeEach(() => {
    cfg = null;
    due = [];
    claimOk = true;
    wakes.length = 0;
    roomRepos = [];
    repoRows = [];
    spaceRows = [];
  });

  it("defaultCron traduce la hora de cada tarea", () => {
    expect(defaultCron("nightly", 2)).toBe("0 2 * * 1-5");
    expect(defaultCron("deps", 9)).toBe("0 9 * * 1");
  });

  it("dueRepoJobs: dentro de la ventana toca, con la hora en la llave; apagado no", async () => {
    const jobs = await dueRepoJobs([rs(), rs({ repo: "acme/web", enabled: false })], MON_0910);
    expect(jobs.map((j) => j.key)).toEqual(["sched:factory-nightly:12:acme/api:2026-10-26T09:00"]);
    expect(await dueRepoJobs([rs({ cron: "0 9 * * 2" })], MON_0910)).toEqual([]);
  });

  it("el repo con horario propio no sigue el del espacio; el otro sí", async () => {
    cfg = { roomId: 12 };
    roomRepos = ["acme/web", "acme/api"];
    due = [row];
    repoRows = [repoRow({ enabled: 0 })];
    await sweepTenant("ns");
    expect(wakes.map((w) => w.key)).toEqual([expect.stringMatching(/^sched:factory-nightly:12:acme\/web:/)]);
  });

  it("el horario propio despierta a @plan con safe-outputs y su repo en el destino", async () => {
    cfg = { roomId: 12 };
    roomRepos = ["acme/web", "acme/api"];
    repoRows = [repoRow({ cron: "* * * * *" })];
    await sweepTenant("ns");
    expect(wakes).toHaveLength(1);
    expect(wakes[0].key).toMatch(/^sched:factory-nightly:12:acme\/api:\d{4}-\d\d-\d\dT\d\d:\d\d$/);
    const ref = wakes[0].ref as { sub: string; dest: Record<string, unknown> };
    expect(ref.sub).toBe("u2");
    expect(ref.dest).toMatchObject({ channelId: 12, handle: "plan", factorySched: "nightly", automationRepo: "acme/api" });
  });

  it("un repo ya desconectado del room no corre", async () => {
    cfg = { roomId: 12 };
    roomRepos = ["acme/web"];
    repoRows = [repoRow({ cron: "* * * * *" })];
    await sweepTenant("ns");
    expect(wakes).toHaveLength(0);
  });

  it("factoryDepsCoverage: una sola vía de dependencias por room+repo", async () => {
    // Sin fábrica no cubre nada (la receta de mantenimiento sí corre).
    spaceRows = [{ kind: "deps", enabled: 1, hour: 9, weekdays_only: 0, tz: "America/Mexico_City" }];
    expect((await factoryDepsCoverage())(12, "acme/api")).toBe(false);
    cfg = { roomId: 12 };
    repoRows = [repoRow({ kind: "deps", enabled: 0 })];
    const covers = await factoryDepsCoverage();
    expect(covers(12, "acme/web")).toBe(true); // sigue la del espacio
    expect(covers(12, "acme/api")).toBe(false); // la apagó para ese repo
  });
});
