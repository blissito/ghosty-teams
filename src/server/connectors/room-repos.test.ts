// El CANDADO del alcance por room. Se prueba `runTool` y no el filtro de `github.server.ts`
// porque el filtro es UX —lo que se le OFRECE al modelo— y esto es la frontera: nada impide
// que el modelo llame una tool que sí se le ofreció con un repo que este room no declaró.
//
// Molde: shared.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";

const listRoomRepos = vi.fn();
const isGroupDm = vi.fn();
vi.mock("../../db.server", () => ({
  listRoomRepos: (...a: unknown[]) => listRoomRepos(...a),
  isGroupDm: (...a: unknown[]) => isGroupDm(...a),
}));

// El dispatch pregunta por los conectores conectados ANTES de ejecutar. Se responde que no
// hay ninguno: a estas pruebas les importa la puerta, no lo que hay detrás — si el candado
// deja pasar, el error es "conector no conectado", que es un caso claramente distinto.
vi.mock("./store.server", () => ({
  listAvailableProviders: async () => [],
  resolveConnectorOwner: async () => null,
}));
vi.mock("./native.server", () => ({ nativeTools: () => [] }));

const { runTool } = await import("./tools.server");

const ROOM = { channelId: 7 };
const DM = { dmId: 3 };

beforeEach(() => {
  isGroupDm.mockReset();
  isGroupDm.mockResolvedValue(false); // por defecto, un DM 1:1
  listRoomRepos.mockReset();
  listRoomRepos.mockResolvedValue([{ repo: "blissito/gs", connectedBy: "ana", createdAt: 0 }]);
});

describe("alcance de repos por room", () => {
  it("deja pasar el repo conectado", async () => {
    const r = await runTool("ana", "github_read_file", { repo: "blissito/gs", path: "a.ts" }, ROOM);
    expect(r.ok).toBe(false);
    // Pasó el candado y murió más abajo, en el conector. Es la señal de que NO lo frenó.
    expect((r as { error: string }).error).toContain("conector no conectado");
  });

  it("bloquea un repo que el room no declaró, y dice cuáles sí", async () => {
    const r = await runTool("ana", "github_read_file", { repo: "otro/privado" }, ROOM);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("no está conectado a este room");
    expect((r as { error: string }).error).toContain("blissito/gs");
  });

  it("ignora la caja: GitHub trata Blissito/GS y blissito/gs como el mismo repo", async () => {
    const r = await runTool("ana", "github_read_file", { repo: "Blissito/GS" }, ROOM);
    expect((r as { error: string }).error).toContain("conector no conectado");
  });

  it("acepta la URL completa, que es lo que se pega", async () => {
    const r = await runTool("ana", "github_get_pr", { repo: "https://github.com/blissito/gs.git" }, ROOM);
    expect((r as { error: string }).error).toContain("conector no conectado");
  });

  it("un room SIN repos no tiene GitHub, y el error manda al botón", async () => {
    listRoomRepos.mockResolvedValue([]);
    const r = await runTool("ana", "github_list_prs", { repo: "blissito/gs" }, ROOM);
    expect((r as { error: string }).error).toContain("no tiene ningún repositorio conectado");
  });

  // Enumeradas a mano en REPOLESS_TOOLS: exigirles `repo` las dejaría rechazadas siempre, y
  // github_install_link es justo lo que hay que poder ofrecer cuando falta un repo.
  it("las tools sin repo pasan mientras el room tenga alguno", async () => {
    const r = await runTool("ana", "github_list_repos", {}, ROOM);
    expect((r as { error: string }).error).toContain("conector no conectado");
  });

  it("pero en un room sin repos tampoco pasan", async () => {
    listRoomRepos.mockResolvedValue([]);
    const r = await runTool("ana", "github_install_link", {}, ROOM);
    expect((r as { error: string }).error).toContain("no tiene ningún repositorio conectado");
  });

  it("en DM 1:1 no hay restricción: es su conexión y nadie más lee la respuesta", async () => {
    const r = await runTool("ana", "github_read_file", { repo: "lo/que/sea" }, DM);
    expect((r as { error: string }).error).toContain("conector no conectado");
    expect(listRoomRepos).not.toHaveBeenCalled();
  });

  it("🔴 en un DM de GRUPO no hay GitHub: lo que uno lee lo verían los demás", async () => {
    // Un DM 1:1 es contigo y lees tus propios repos. En grupo, el agente lee con el token de
    // QUIEN ESCRIBIÓ y lo vuelca a gente que en GitHub puede no tener ese acceso — que es
    // exactamente el daño que motivó atar los repos a los rooms.
    isGroupDm.mockResolvedValue(true);
    const r = await runTool("ana", "github_read_file", { repo: "acme/privado" }, DM);
    expect((r as { error: string }).error).toContain("chat de grupo");
    // Y no se le manda al botón del encabezado del room, que ahí no existe.
    expect((r as { error: string }).error).not.toContain("encabezado del room");
  });

  it("un DM cuyo tipo no se puede leer se trata como grupo, no como 1:1", async () => {
    // Falla CERRADO: una base intermitente no puede abrir la frontera.
    isGroupDm.mockRejectedValue(new Error("db caída"));
    const r = await runTool("ana", "github_read_file", { repo: "acme/privado" }, DM);
    expect((r as { error: string }).error).toContain("chat de grupo");
  });

  it("dentro de un HILO manda el mismo room: el candado no cambia", async () => {
    // Un hilo vive dentro de su canal, así que el alcance de repos es el del canal. Se fija
    // aquí porque el `dest` de un hilo trae `parentId` además de `channelId`, y un candado
    // que mirara el campo equivocado dejaría los hilos sin frontera sin que nadie lo notara.
    const HILO = { channelId: 7, parentId: 2214 };
    expect(await runTool("ana", "github_read_file", { repo: "blissito/gs" }, HILO)).not.toMatchObject({
      error: expect.stringContaining("no está conectado"),
    });
    const r = await runTool("ana", "github_read_file", { repo: "otro/ajeno" }, HILO);
    expect((r as { error: string }).error).toContain("no está conectado a este room");
  });

  it("no toca las tools que no son de GitHub", async () => {
    const r = await runTool("ana", "sentry_list_issues", {}, ROOM);
    expect((r as { error: string }).error).toContain("conector no conectado");
    expect(listRoomRepos).not.toHaveBeenCalled();
  });

  // Un fallo de DB no puede ABRIR la frontera: se lee como "sin repos", que cierra.
  it("si la DB falla, cierra en vez de abrir", async () => {
    listRoomRepos.mockRejectedValue(new Error("sqld caído"));
    const r = await runTool("ana", "github_read_file", { repo: "blissito/gs" }, ROOM);
    expect((r as { error: string }).error).toContain("no tiene ningún repositorio conectado");
  });
});
