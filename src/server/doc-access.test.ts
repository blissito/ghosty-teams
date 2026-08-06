import { beforeEach, describe, expect, it, vi } from "vitest";

// `resolveExportDoc` decide QUÉ versión se lee en voz alta, se revisa y se baja. Es el
// punto donde un `?v` que no resuelve cae a la ÚLTIMA versión EN SILENCIO — y esa caída,
// combinada con que dos ```eb-doc``` seguidos comparten `documentId`, es lo que hacía que
// abrir el penúltimo documento y darle play sonara el último.
//
// La caída se conserva a propósito (un 404 a media narración es peor), así que se fija con
// un test: si alguien la quita creyéndola un descuido, que se entere aquí.
const listArtifactVersions = vi.fn();
const getArtifactVersion = vi.fn();
const getDoc = vi.fn();
const shareRootFor = vi.fn();
const canSeeChannel = vi.fn();
const dbq = vi.fn();

vi.mock("../db.server", () => ({
  listArtifactVersions: (...a: unknown[]) => listArtifactVersions(...a),
  getArtifactVersion: (...a: unknown[]) => getArtifactVersion(...a),
  getDoc: (...a: unknown[]) => getDoc(...a),
  shareRootFor: (...a: unknown[]) => shareRootFor(...a),
  canSeeChannel: (...a: unknown[]) => canSeeChannel(...a),
}));
vi.mock("../dbq.server", () => ({
  dbq: (...a: unknown[]) => dbq(...a),
  num: (v: unknown) => Number(v),
}));

const { resolveExportDoc } = await import("./doc-access.server");

const YO = { sub: "ana", isOwner: false };

beforeEach(() => {
  vi.resetAllMocks();
  // Tres versiones del mismo documento: la 10 y la 11 son el documento A, la 12 es el
  // SEGUNDO documento que el hilo colgó del mismo `documentId`.
  listArtifactVersions.mockResolvedValue([{ id: 10 }, { id: 11 }, { id: 12 }]);
  getArtifactVersion.mockImplementation(async (id: number) => ({ id, md: `md-${id}`, title: `t${id}` }));
  getDoc.mockResolvedValue({ kind: "doc" });
  shareRootFor.mockResolvedValue({ ownerSub: "ana", visibility: "private" });
  dbq.mockResolvedValue([]);
});

describe("qué versión se sirve", () => {
  it("un `v` que existe sirve ESA, no la última", async () => {
    expect((await resolveExportDoc("doc-1", 11, YO))?.versionId).toBe(11);
  });

  it("acepta el `v` como NÚMERO (el router parsea los search params como JSON)", async () => {
    expect((await resolveExportDoc("doc-1", "11", YO))?.versionId).toBe(11);
  });

  it("sin `v` sirve la última — es el contrato del enlace 'latest'", async () => {
    expect((await resolveExportDoc("doc-1", null, YO))?.versionId).toBe(12);
    expect((await resolveExportDoc("doc-1", "latest", YO))?.versionId).toBe(12);
  });

  it("un `v` PODADO cae a la última, y esa caída es deliberada", async () => {
    // Se guardan 20 versiones: pedir una que ya se barrió no puede ser un 404 a media
    // narración. Lo que sí hace el servidor es delatarse por `X-Doc-Version`.
    expect((await resolveExportDoc("doc-1", 3, YO))?.versionId).toBe(12);
  });

  it("sin versiones no hay documento", async () => {
    listArtifactVersions.mockResolvedValue([]);
    expect(await resolveExportDoc("doc-1", null, YO)).toBeNull();
  });

  it("sin permiso responde igual que si no existiera", async () => {
    shareRootFor.mockResolvedValue({ ownerSub: "beto", visibility: "private" });
    dbq.mockResolvedValue([{ id: "7", is_private: "1" }]);
    canSeeChannel.mockReturnValue(false);
    expect(await resolveExportDoc("doc-1", 11, YO)).toBeNull();
  });
});
