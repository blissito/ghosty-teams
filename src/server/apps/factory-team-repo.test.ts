import { describe, expect, it, vi } from "vitest";

// De qué repo es un turno de la fábrica en un room con VARIOS: sin eso se queda sin `.ghosty/factory.md`.
const overrides = new Map<string, string>();
vi.mock("../../dbq.server", () => ({
  dbq: async (sql: string, args: unknown[] = []) => {
    if (sql.startsWith("SELECT overrides")) {
      const o = overrides.get(`${args[0]}:${args[1]}`);
      return o ? [{ overrides: o }] : [];
    }
    return [];
  },
}));
vi.mock("./installed.server", () => ({ isInstalled: async () => true, getAppConfig: async () => null }));
vi.mock("../../db.server", () => ({
  listRoomRepos: async () => [{ repo: "acme/web", connectedBy: "u" }, { repo: "acme/api", connectedBy: "u" }],
  getMessage: async () => null,
}));
vi.mock("./factory-runs.server", () => ({ runOfThread: async () => null }));
vi.mock("./factory", () => ({ studioAgents: async () => [] }));
vi.mock("../connectors/github.server", () => ({ githubApi: async () => null }));

const { factoryTurnFor } = await import("./factory-team.server");

describe("factoryTurnFor: el repo en un room con varios", () => {
  it("el hilo de una automatización lo trae en sus overrides", async () => {
    overrides.set("7:101", JSON.stringify({ repo: "acme/api" }));
    const t = await factoryTurnFor("build", { channelId: 7, parentId: 101, handle: "build" }, "f");
    expect(t?.repo).toBe("acme/api");
  });

  it("un turno top-level (tarea programada, mantenimiento) lo trae en el destino", async () => {
    const t = await factoryTurnFor("plan", { channelId: 7, handle: "plan", automationRepo: "ACME/web", factorySched: "nightly" }, "f");
    expect(t?.repo).toBe("acme/web");
  });

  it("sin nada que lo diga, sigue sin repo (como antes)", async () => {
    const t = await factoryTurnFor("plan", { channelId: 7, handle: "plan" }, "f");
    expect(t?.repo).toBeNull();
  });
});
