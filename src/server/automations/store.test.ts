import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";

// claim y budget dependen de la semántica de SQLite (upsert con WHERE + RETURNING): se prueban
// contra un SQLite real en memoria con las mismas tablas de schema.server.ts.
let db: DatabaseSync;
vi.mock("../../dbq.server", () => ({
  dbq: async (sql: string, args: unknown[] = []) => db.prepare(sql).all(...(args as never[])),
}));

const S = await import("./store.server");

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE gt_repo_automations (ns TEXT NOT NULL, room_id INTEGER NOT NULL, repo TEXT NOT NULL, kind TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0, settings_json TEXT, updated_by TEXT, updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (room_id, repo, kind))`);
  db.exec(`CREATE TABLE gt_automation_claims (kind TEXT NOT NULL, key TEXT NOT NULL, expires_at INTEGER NOT NULL,
    claimed_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY (kind, key))`);
  db.exec(`CREATE TABLE gt_automation_budget (repo TEXT NOT NULL, kind TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (repo, kind, day))`);
});

describe("lo durable de las automatizaciones", () => {
  it("claim: sólo la primera vez dentro del ttl; vencido, se puede otra vez", async () => {
    expect(await S.claimKey("ci_fix", "acme/app#3:1")).toBe(true);
    expect(await S.claimKey("ci_fix", "acme/app#3:1")).toBe(false);
    expect(await S.claimKey("ci_fix", "acme/app#3:2"), "otro intento es otra clave").toBe(true);
    expect(await S.claimKey("dep_fix", "acme/app#3:1"), "otro tipo es otra clave").toBe(true);
    db.exec("UPDATE gt_automation_claims SET expires_at = unixepoch() - 1 WHERE key = 'acme/app#3:1' AND kind = 'ci_fix'");
    expect(await S.claimKey("ci_fix", "acme/app#3:1")).toBe(true);
  });

  it("budget: hasta el tope del día por repo y tipo", async () => {
    const t = Date.UTC(2026, 9, 25, 18);
    for (let i = 0; i < 3; i++) expect(await S.spendBudget("Acme/App", "ci_fix", 3, t)).toBe(true);
    expect(await S.spendBudget("acme/app", "ci_fix", 3, t), "el repo no distingue mayúsculas").toBe(false);
    expect(await S.spendBudget("acme/app", "ci_doctor", 3, t), "otro tipo tiene su tope").toBe(true);
    expect(await S.spendBudget("acme/app", "ci_fix", 3, t + 86_400_000), "al día siguiente se renueva").toBe(true);
    expect(await S.spendBudget("acme/app", "ci_fix", 0, t)).toBe(false);
  });

  it("política: apagada por default; prender guarda quién y los ajustes; apagar no los borra", async () => {
    expect(await S.listRepoAutomations(7, "acme/app")).toEqual([]);
    expect((await S.enabledByRoom("acme/app")).size).toBe(0);
    await S.setRepoAutomation({ ns: "ns", roomId: 7, repo: "Acme/App", kind: "security_fix", enabled: true, settings: { minSeverity: "high" }, by: "u1" });
    const on = await S.enabledByRoom("ACME/app");
    expect([...on.get(7)!.kinds]).toEqual(["security_fix"]);
    expect(await S.automationOwner(7, "acme/app", "security_fix")).toBe("u1");
    expect(await S.automationSettings(7, "acme/app", "security_fix")).toEqual({ minSeverity: "high" });
    await S.setRepoAutomation({ ns: "ns", roomId: 7, repo: "acme/app", kind: "security_fix", enabled: false, by: "u2" });
    expect((await S.enabledByRoom("acme/app")).size).toBe(0);
    expect(await S.automationOwner(7, "acme/app", "security_fix")).toBe(null);
    expect(await S.automationSettings(7, "acme/app", "security_fix")).toEqual({ minSeverity: "high" });
  });
});
