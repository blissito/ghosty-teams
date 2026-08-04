import { beforeEach, describe, expect, it, vi } from "vitest";

// Molde: src/server/connectors/holders.test.ts. `store.server.ts` usa `dbq` (filas-objeto).
const dbq = vi.fn();
vi.mock("../../dbq.server", () => ({
  dbq: (...a: unknown[]) => dbq(...a),
  dbqMany: vi.fn(),
  num: (v: unknown) => Number(v),
}));

const { resolveConnectorOwner, listAvailableProviders, setConnectorShared } = await import("./store.server");

beforeEach(() => dbq.mockReset());

describe("resolveConnectorOwner", () => {
  it("devuelve la propia y la marca como no compartida", async () => {
    dbq.mockResolvedValueOnce([{ user_sub: "ana", shared: "0" }]);
    expect(await resolveConnectorOwner("ana", "sentry")).toEqual({ ownerSub: "ana", shared: false });
  });

  it("sin propia, cae a la compartida de otro", async () => {
    dbq.mockResolvedValueOnce([{ user_sub: "david", shared: "1" }]);
    expect(await resolveConnectorOwner("ana", "sentry")).toEqual({ ownerSub: "david", shared: true });
  });

  it("sin ninguna, null", async () => {
    dbq.mockResolvedValueOnce([]);
    expect(await resolveConnectorOwner("ana", "sentry")).toBeNull();
  });

  it("la PROPIA gana a la compartida", async () => {
    // Es la garantía de que el agente actúa con MIS permisos cuando los tengo: si la
    // compartida ganara, un miembro haría en Sentry cosas que su cuenta no puede.
    // El desempate es del ORDER BY, así que se comprueba que la consulta lo lleve.
    dbq.mockResolvedValueOnce([{ user_sub: "ana", shared: "0" }]);
    await resolveConnectorOwner("ana", "sentry");
    const sql = String(dbq.mock.calls[0][0]).replace(/\s+/g, " ");
    expect(sql).toContain("ORDER BY (user_sub=?) DESC");
    expect(sql).toContain("access_token IS NOT NULL");
    // Y que el sub viaje tanto para el filtro como para el desempate.
    expect(dbq.mock.calls[0][1]).toEqual(["sentry", "ana", "ana"]);
  });
});

describe("listAvailableProviders", () => {
  it("incluye los míos y los compartidos", async () => {
    dbq.mockResolvedValueOnce([{ provider: "denik" }, { provider: "sentry" }]);
    const out = await listAvailableProviders("ana");
    expect([...out].sort()).toEqual(["denik", "sentry"]);
    const sql = String(dbq.mock.calls[0][0]).replace(/\s+/g, " ");
    expect(sql).toContain("user_sub=? OR shared=1");
  });
});

describe("setConnectorShared", () => {
  it("sólo toca la columna shared — nunca el token", async () => {
    dbq.mockResolvedValueOnce([]);
    await setConnectorShared("david", "sentry", true);
    const sql = String(dbq.mock.calls[0][0]);
    expect(sql).toContain("SET shared=?");
    expect(sql).not.toMatch(/access_token|refresh_token|DELETE/);
    expect(dbq.mock.calls[0][1]).toEqual([1, "david", "sentry"]);
  });
});
