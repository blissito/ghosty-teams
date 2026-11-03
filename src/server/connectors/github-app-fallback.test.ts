// Respaldo con la App (3-nov): quien pide sin GitHub trabaja con la App, pero sólo sobre repos
// conectados a un room — y en un turno del agente, sólo sobre los de SU room.
import { beforeEach, describe, expect, it, vi } from "vitest";

const roomRepos = new Set(["blissito/agenda"]);

vi.mock("./oauth.server", () => ({ getValidToken: async () => null }));
vi.mock("./store.server", () => ({ getConnectorRow: async () => null }));
vi.mock("../../db.server", () => ({ listRoomRepos: async () => [] }));
vi.mock("../../dbq.server", () => ({
  dbq: async (_sql: string, args: unknown[]) => (roomRepos.has(String(args[0]).toLowerCase()) ? [{ x: 1 }] : []),
}));
vi.mock("./github-app.server", () => ({
  appJwtOrNull: () => "jwt",
  botIdentityEnabled: () => true,
  coAuthorTrailer: () => "",
  installationToken: async (_id: number, o?: { onlyRepo?: string }) => `inst:${o?.onlyRepo ?? "*"}`,
  pushDenialReason: async () => null,
  agentTrailer: () => "",
}));

const seen: string[] = [];
beforeEach(() => {
  seen.length = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
    if (url.endsWith("/installation")) return new Response(JSON.stringify({ id: 7 }), { status: 200 });
    seen.push(auth);
    return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
  });
});

describe("respaldo con la GitHub App", () => {
  it("repoOfPath saca owner/name de la ruta", async () => {
    const G = await import("./github.server");
    expect(G.repoOfPath("/repos/blissito/agenda/pulls/3")).toBe("blissito/agenda");
    expect(G.repoOfPath("/user/repos")).toBeNull();
  });

  it("plataforma: repo conectado a un room → token de instalación recortado a ese repo", async () => {
    const G = await import("./github.server");
    const r = await G.githubApi("brenda", "/repos/blissito/agenda/pulls/3");
    expect(r).toEqual({ ok: 1 });
    expect(seen).toEqual(["Bearer inst:agenda"]);
  });

  it("plataforma: repo que nadie conectó → sin respaldo", async () => {
    const G = await import("./github.server");
    const r = await G.githubApi("brenda", "/repos/otro/privado/contents/x");
    expect(r.error).toMatch(/no está conectada/);
    expect(seen).toEqual([]);
  });

  it("turno del agente: sólo los repos de su room, aunque el espacio tenga otros", async () => {
    const G = await import("./github.server");
    roomRepos.add("blissito/otro-room");
    const fuera = await G.withAgentRepoScope(["blissito/agenda"], () => G.githubApi("brenda", "/repos/blissito/otro-room/pulls/1"));
    expect(fuera.error).toMatch(/no está conectada/);
    const dentro = await G.withAgentRepoScope(["Blissito/Agenda"], () => G.githubApi("brenda", "/repos/blissito/agenda/pulls/1"));
    expect(dentro).toEqual({ ok: 1 });
    roomRepos.delete("blissito/otro-room");
  });

  it("turno en DM (scope vacío): nada de respaldo", async () => {
    const G = await import("./github.server");
    const r = await G.withAgentRepoScope([], () => G.githubApi("brenda", "/repos/blissito/agenda/pulls/1"));
    expect(r.error).toMatch(/no está conectada/);
  });

  it("empujar sin GitHub propio: escribe la App sobre el repo del room", async () => {
    const G = await import("./github.server");
    expect(await G.gitWriteToken("brenda", "blissito/agenda")).toEqual({ token: "inst:agenda", bot: true });
    expect(await G.gitWriteToken("brenda", "otro/privado")).toHaveProperty("error");
  });
});
