import { beforeEach, describe, expect, it, vi } from "vitest";

// `createArtifact` devuelve el id de la fila que acaba de insertar, y ése es el eslabón
// que sostiene todo el pin de versión: sin él, el editor tiene que pedir "la última"
// después de guardar, y en un hilo con dos documentos "la última" es el OTRO documento.
//
// Es exactamente el tipo de detalle que un refactor devuelve a `Promise<void>` sin que
// nadie lo note (el bug no da error: da el documento equivocado). De ahí este test.
const dbq = vi.fn();
vi.mock("../dbq.server", () => ({
  dbq: (...a: unknown[]) => dbq(...a),
  dbqMany: vi.fn(),
  num: (v: unknown) => Number(v),
}));

const { createArtifact } = await import("../db.server");

beforeEach(() => dbq.mockReset());

describe("createArtifact", () => {
  it("devuelve el id del INSERT, no lo re-consulta", async () => {
    dbq.mockResolvedValueOnce([{ id: "42" }]);
    const id = await createArtifact(7, { kind: "doc", url: "doc-1", md: "x" });
    expect(id).toBe(42);
    // UNA sola consulta: un `SELECT … ORDER BY id DESC` posterior devolvería la fila de
    // una publicación concurrente, o sea el documento de otro.
    expect(dbq).toHaveBeenCalledTimes(1);
    expect(String(dbq.mock.calls[0][0])).toMatch(/RETURNING id/);
  });
});
