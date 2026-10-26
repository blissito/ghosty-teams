import { beforeEach, describe, expect, it, vi } from "vitest";

// A qué pedido le llega una nota (`factory_note`, «@build quita eso»): el `runId` o el PR que
// nombra el agente pueden ser de OTRO room. Sólo vale si quien la manda ve ese room; si no,
// una nota escrita en un canal abierto acabaría metiendo instrucciones a @build en el pedido
// de un canal privado ajeno.
let roomRepos: Record<number, string[]> = {};
let visible: number[] = [];
let runs: { id: number; channelId: number; repo: string; pr: number }[] = [];

vi.mock("./installed.server", () => ({ isInstalled: async () => true }));
vi.mock("../../db.server", () => ({
  listRoomRepos: async (channelId: number) => (roomRepos[channelId] ?? []).map((repo) => ({ repo })),
  listChannels: async () => visible.map((id) => ({ id })),
}));
vi.mock("./factory-runs.server", () => ({
  runsByPr: async (repo: string, n: number) => runs.filter((r) => r.repo === repo && r.pr === n),
  getRun: async (id: number) => runs.find((r) => r.id === id) ?? null,
}));

const { runOfPr, resolveNoteRun } = await import("./factory-tools.server");
const dest = (channelId: number) => ({ channelId }) as never;

beforeEach(() => {
  roomRepos = { 14: ["o/app"] };
  visible = [14];
  runs = [];
});

describe("runOfPr", () => {
  it("#8 en un room con su repo: el pedido de ese PR", async () => {
    runs = [{ id: 1, channelId: 14, repo: "o/app", pr: 8 }];
    expect(await runOfPr(dest(14), "ana", "#8")).toMatchObject({ id: 1 });
    expect(await runOfPr(dest(14), "ana", 8)).toMatchObject({ id: 1 });
  });

  it("la liga del PR manda sobre los repos del room", async () => {
    runs = [{ id: 2, channelId: 14, repo: "o/otro", pr: 3 }];
    expect(await runOfPr(dest(14), "ana", "https://github.com/o/otro/pull/3")).toMatchObject({ id: 2 });
  });

  it("si hay varios pedidos del mismo PR gana el más nuevo", async () => {
    runs = [
      { id: 5, channelId: 14, repo: "o/app", pr: 8 },
      { id: 9, channelId: 14, repo: "o/app", pr: 8 },
    ];
    expect(await runOfPr(dest(14), "ana", "8")).toMatchObject({ id: 9 });
  });

  it("el pedido vive en un room que la persona NO ve: no hay pedido", async () => {
    runs = [{ id: 3, channelId: 99, repo: "o/app", pr: 8 }];
    expect(await runOfPr(dest(14), "ana", "#8")).toBeNull();
    visible = [14, 99];
    expect(await runOfPr(dest(14), "ana", "#8")).toMatchObject({ id: 3 });
  });

  it("basura o sin room: null", async () => {
    for (const pr of ["", null, "abc", "0", "-3"]) expect(await runOfPr(dest(14), "ana", pr)).toBeNull();
    expect(await runOfPr(null, "ana", "8")).toBeNull();
  });
});

describe("resolveNoteRun con runId explícito", () => {
  it("del mismo room: sí", async () => {
    runs = [{ id: 7, channelId: 14, repo: "o/app", pr: 1 }];
    expect(await resolveNoteRun(dest(14), "ana", 7)).toMatchObject({ id: 7 });
  });

  it("de un room ajeno que no ve: null; si lo ve: sí", async () => {
    runs = [{ id: 7, channelId: 99, repo: "o/app", pr: 1 }];
    expect(await resolveNoteRun(dest(14), "ana", 7)).toBeNull();
    visible = [14, 99];
    expect(await resolveNoteRun(dest(14), "ana", 7)).toMatchObject({ id: 7 });
  });

  it("un runId que no existe: null", async () => {
    expect(await resolveNoteRun(dest(14), "ana", 404)).toBeNull();
  });

  it("con PR explícito se resuelve por el PR (y su misma regla de visibilidad)", async () => {
    runs = [{ id: 3, channelId: 99, repo: "o/app", pr: 8 }];
    expect(await resolveNoteRun(dest(14), "ana", 3, "#8")).toBeNull();
  });
});
