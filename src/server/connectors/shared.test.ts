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

  it("la PROPIA gana, el desempate es estable y los expulsados quedan fuera", async () => {
    // Tres garantías que viven en el SQL y por eso se comprueban ahí:
    //  · la propia gana → el agente actúa con MIS permisos cuando los tengo;
    //  · `user_sub ASC` → con dos compartidas la elegida no cambia entre llamadas, o el
    //    panel nombraría a una persona y el agente usaría la conexión de otra;
    //  · el LEFT JOIN con banned → expulsar a alguien deja de prestar su token (expulsar
    //    sólo pone banned=1 y no toca gc_user_connectors).
    dbq.mockResolvedValueOnce([{ user_sub: "ana", shared: "0" }]);
    await resolveConnectorOwner("ana", "sentry");
    const sql = String(dbq.mock.calls[0][0]).replace(/\s+/g, " ");
    expect(sql).toContain("ORDER BY (c.user_sub=?) DESC, c.user_sub ASC");
    expect(sql).toContain("access_token IS NOT NULL");
    expect(sql).toContain("COALESCE(u.banned,0)=0");
    // La propia NO se filtra por banned: si estás baneado no llegas hasta aquí.
    expect(sql).toContain("c.user_sub=? OR (c.shared=1");
    expect(dbq.mock.calls[0][1]).toEqual(["sentry", "ana", "ana"]);
  });
});

describe("listAvailableProviders", () => {
  it("incluye los míos y los compartidos", async () => {
    dbq.mockResolvedValueOnce([{ provider: "denik" }, { provider: "sentry" }]);
    const out = await listAvailableProviders("ana");
    expect([...out].sort()).toEqual(["denik", "sentry"]);
    const sql = String(dbq.mock.calls[0][0]).replace(/\s+/g, " ");
    expect(sql).toContain("c.user_sub=? OR (c.shared=1");
    expect(sql).toContain("COALESCE(u.banned,0)=0");
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
