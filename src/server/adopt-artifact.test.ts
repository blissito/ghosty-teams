import { beforeEach, describe, expect, it, vi } from "vitest";

// `adoptableArtifact` decide QUIÉN puede llevarse un artefacto a otra conversación, así que
// sus reglas se fijan con tests: aflojarlas sin querer expone documentos de rooms privados.
const dbq = vi.fn();
vi.mock("../dbq.server", () => ({
  dbq: (...a: unknown[]) => dbq(...a),
  dbqMany: vi.fn(),
  num: (v: unknown) => Number(v),
}));

const { adoptableArtifact, slugDeArtefactoEn } = await import("../db.server");

/** Una fila como la devuelve el join de gc_artifacts + gc_messages. */
function fila(opts: { url?: string; owner?: string | null; canal?: number | null }) {
  dbq.mockResolvedValueOnce([
    {
      url: opts.url ?? "doc-1",
      owner_sub: opts.owner ?? null,
      channel_id: opts.canal == null ? null : String(opts.canal),
    },
  ]);
}

beforeEach(() => dbq.mockReset());

describe("quién puede adoptar un artefacto", () => {
  it("su DUEÑO se lo lleva a cualquier conversación", async () => {
    fila({ owner: "ana", canal: 99 }); // nació en OTRO room
    expect(await adoptableArtifact("s", { requesterSub: "ana", channelId: 1 })).toBe("doc-1");
  });

  it("cualquiera del room lo adopta si NACIÓ AHÍ — ya lo ve en el historial", async () => {
    fila({ owner: "ana", canal: 7 });
    expect(await adoptableArtifact("s", { requesterSub: "beto", channelId: 7 })).toBe("doc-1");
  });

  it("un artefacto de OTRO room, pedido por quien no es dueño, se NIEGA", async () => {
    fila({ owner: "ana", canal: 99 });
    expect(await adoptableArtifact("s", { requesterSub: "beto", channelId: 7 })).toBeNull();
  });

  it("el dueño del WORKSPACE puede: la app ya le muestra todos los rooms privados", async () => {
    fila({ owner: "ana", canal: 99 });
    expect(
      await adoptableArtifact("s", { requesterSub: "beto", channelId: 7, isWorkspaceOwner: true }),
    ).toBe("doc-1");
  });

  it("un slug inexistente devuelve null, no lanza", async () => {
    dbq.mockResolvedValueOnce([]);
    expect(await adoptableArtifact("no-existe", { requesterSub: "ana", channelId: 7 })).toBeNull();
  });

  it("sin slug ni siquiera consulta la base", async () => {
    expect(await adoptableArtifact("", { requesterSub: "ana", channelId: 7 })).toBeNull();
    expect(dbq).not.toHaveBeenCalled();
  });

  // Un visitante sin sesión no puede heredar el artefacto de nadie por el hecho de que
  // `owner_sub` también sea null.
  it("sin sesión y con artefacto sin dueño, NO se adopta desde otro room", async () => {
    fila({ owner: null, canal: 99 });
    expect(await adoptableArtifact("s", { requesterSub: null, channelId: 7 })).toBeNull();
  });
});

describe("de dónde se saca el slug", () => {
  it("de la URL completa, ignorando el ?v=", () => {
    expect(
      slugDeArtefactoEn("mira https://business.teams.ghosty.studio/artefacto/61ce6dea-94a5?v=202"),
    ).toBe("61ce6dea-94a5");
  });

  it("de la ruta suelta", () => {
    expect(slugDeArtefactoEn("/artefacto/abc123def")).toBe("abc123def");
  });

  // Gana el ÚLTIMO: es el que la persona acaba de pegar, no el que quedó arriba del hilo.
  it("con varios links, gana el último", () => {
    expect(slugDeArtefactoEn("antes /artefacto/viejo1234 y ahora /artefacto/nuevo5678")).toBe(
      "nuevo5678",
    );
  });

  it("un texto sin links no toca nada", () => {
    expect(slugDeArtefactoEn("hazme una landing de vinos")).toBeNull();
    expect(slugDeArtefactoEn("")).toBeNull();
  });

  it("no confunde otras rutas del sitio", () => {
    expect(slugDeArtefactoEn("https://teams.ghosty.studio/c/general")).toBeNull();
  });
});
