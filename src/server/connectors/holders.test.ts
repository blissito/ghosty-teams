import { beforeEach, describe, expect, it, vi } from "vitest";

// Mismo patrón que src/server/adopt-artifact.test.ts: se mockea el cliente de DB y se
// ejercita la función real. `store.server.ts` usa `dbq` (filas-objeto), no `dbqRaw`.
const dbq = vi.fn();
vi.mock("../../dbq.server", () => ({
  dbq: (...a: unknown[]) => dbq(...a),
  dbqMany: vi.fn(),
  num: (v: unknown) => Number(v),
}));

const { listConnectorHolders } = await import("./store.server");

beforeEach(() => dbq.mockReset());

describe("listConnectorHolders", () => {
  it("agrupa por proveedor", async () => {
    dbq.mockResolvedValueOnce([
      { user_sub: "ana", provider: "sentry" },
      { user_sub: "david", provider: "sentry" },
      { user_sub: "ana", provider: "github" },
    ]);
    const out = await listConnectorHolders();
    expect(out.get("sentry")).toEqual(["ana", "david"]);
    expect(out.get("github")).toEqual(["ana"]);
    expect(out.size).toBe(2);
  });

  it("una tabla vacía devuelve un mapa vacío, no undefined", async () => {
    dbq.mockResolvedValueOnce([]);
    expect((await listConnectorHolders()).size).toBe(0);
  });

  it("sólo cuenta conexiones vivas", async () => {
    // El filtro es de SQL (`access_token IS NOT NULL`), así que lo que se comprueba es que
    // la consulta lo lleve: sin él aparecerían como conectadas filas de gente que ya
    // desconectó, y el panel diría que alguien tiene algo que no tiene.
    dbq.mockResolvedValueOnce([]);
    await listConnectorHolders();
    expect(String(dbq.mock.calls[0][0])).toContain("access_token IS NOT NULL");
  });

  it("descarta filas incompletas en vez de meter claves basura", async () => {
    dbq.mockResolvedValueOnce([
      { user_sub: "ana", provider: null },
      { user_sub: null, provider: "sentry" },
      { user_sub: "david", provider: "sentry" },
    ]);
    const out = await listConnectorHolders();
    expect(out.size).toBe(1);
    expect(out.get("sentry")).toEqual(["david"]);
  });
});
