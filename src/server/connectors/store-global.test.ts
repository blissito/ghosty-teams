import { beforeEach, describe, expect, it, vi } from "vitest";

// Conexiones globales en gs + marca «compartida» por espacio (store.server.ts, 2026-10-03).
// gs se simula con un mapa (`gsRows`) detrás de `call`; el espacio, con filas en memoria
// detrás de `dbq` (sólo las consultas que usa el store).
type Row = { user_sub: string; provider: string; access_token: string | null; refresh_token: string | null; shared: number; banned?: number };
let gsRows: Map<string, any>;
let local: Row[];
let gsDown: boolean;
const k = (s: string, p: string) => `${s}|${p}`;

vi.mock("./studio-bridge.server", () => ({
  call: async (sub: string, b: any) => {
    if (gsDown) return null;
    if (b.action === "cred.get") return { ok: true, row: gsRows.get(k(sub, b.provider)) ?? null };
    if (b.action === "cred.set") {
      gsRows.set(k(sub, b.provider), { user_sub: sub, provider: b.provider, access_token: b.accessToken, refresh_token: b.refreshToken ?? null, expires_at: null, external_id: null, meta: null, meta_at: null });
      return { ok: true };
    }
    if (b.action === "cred.delete") { gsRows.delete(k(sub, b.provider)); return { ok: true }; }
    if (b.action === "cred.list") return { ok: true, providers: [...gsRows.values()].filter((r) => r.user_sub === sub).map((r) => r.provider) };
    if (b.action === "cred.holders") {
      const h: Record<string, string[]> = {};
      for (const r of gsRows.values()) if (b.subs.includes(r.user_sub)) (h[r.user_sub] ??= []).push(r.provider);
      return { ok: true, holders: h };
    }
    return { ok: true };
  },
}));

vi.mock("../../dbq.server", () => ({
  dbq: async (sql: string, p: any[] = []) => {
    const q = sql.replace(/\s+/g, " ");
    const banned = (s: string) => local.some((r) => r.user_sub === s && r.banned);
    if (q.startsWith("SELECT user_sub, provider, access_token")) return local.filter((r) => r.user_sub === p[0] && r.provider === p[1]);
    if (q.startsWith("UPDATE gc_user_connectors SET access_token=NULL")) { for (const r of local) if (r.user_sub === p[0] && r.provider === p[1]) { r.access_token = null; r.refresh_token = null; } return []; }
    if (q.startsWith("INSERT INTO gc_user_connectors (user_sub, provider, access_token, created_at)")) { if (!local.some((r) => r.user_sub === p[0] && r.provider === p[1])) local.push({ user_sub: p[0], provider: p[1], access_token: null, refresh_token: null, shared: 0 }); return []; }
    if (q.startsWith("UPDATE gc_user_connectors SET shared=?")) { for (const r of local) if (r.user_sub === p[1] && r.provider === p[2]) r.shared = p[0]; return []; }
    if (q.startsWith("SELECT c.user_sub FROM gc_user_connectors c")) return local.filter((r) => r.provider === p[0] && r.shared && !banned(r.user_sub) && r.user_sub !== p[1]).sort((a, b) => a.user_sub.localeCompare(b.user_sub));
    if (q.startsWith("SELECT c.user_sub, c.provider FROM gc_user_connectors c")) return local.filter((r) => r.shared && !banned(r.user_sub)).sort((a, b) => a.user_sub.localeCompare(b.user_sub));
    if (q.startsWith("SELECT provider FROM gc_user_connectors WHERE user_sub=? AND access_token IS NOT NULL")) return local.filter((r) => r.user_sub === p[0] && r.access_token);
    if (q.startsWith("SELECT sub FROM gc_users")) return [...new Set(local.map((r) => r.user_sub))].filter((s) => !banned(s)).map((sub) => ({ sub }));
    if (q.startsWith("SELECT user_sub, provider FROM gc_user_connectors WHERE access_token IS NOT NULL")) return local.filter((r) => r.access_token);
    if (q.startsWith("DELETE FROM gc_user_connectors")) { local = local.filter((r) => !(r.user_sub === p[0] && r.provider === p[1])); return []; }
    return [];
  },
  dbqMany: vi.fn(),
  num: (v: unknown) => Number(v),
}));

const S = await import("./store.server");

beforeEach(() => {
  gsRows = new Map();
  local = [];
  gsDown = false;
  S.resetConnectorCacheForTests();
});

describe("conexión global", () => {
  it("conectar en un espacio la deja en gs y el espacio guarda sólo la marca", async () => {
    await S.setConnectorRow({ sub: "ana", provider: "github", accessToken: "tok" });
    expect(gsRows.get("ana|github").access_token).toBe("tok");
    expect(local).toEqual([{ user_sub: "ana", provider: "github", access_token: null, refresh_token: null, shared: 0 }]);
    expect((await S.getConnectorRow("ana", "github"))?.access_token).toBe("tok");
  });

  it("una copia vieja del espacio sube a gs la primera vez que se lee", async () => {
    local.push({ user_sub: "ana", provider: "sentry", access_token: "viejo", refresh_token: "r", shared: 1 });
    expect((await S.getConnectorRow("ana", "sentry"))?.access_token).toBe("viejo");
    expect(gsRows.get("ana|sentry").access_token).toBe("viejo");
    expect(local[0]).toMatchObject({ access_token: null, shared: 1 }); // la marca compartida sobrevive
  });

  it("si gs no contesta, se usa la copia del espacio como antes", async () => {
    gsDown = true;
    local.push({ user_sub: "ana", provider: "odoo", access_token: "k", refresh_token: null, shared: 0 });
    expect((await S.getConnectorRow("ana", "odoo"))?.access_token).toBe("k");
    expect(local[0].access_token).toBe("k");
  });

  it("desconectar borra en gs y la marca del espacio", async () => {
    await S.setConnectorRow({ sub: "ana", provider: "github", accessToken: "tok" });
    await S.deleteConnectorRow("ana", "github");
    expect(gsRows.has("ana|github")).toBe(false);
    expect(local).toEqual([]);
  });
});

describe("compartidas (por espacio)", () => {
  it("la PROPIA gana; sin propia, la compartida estable (alfabética) de alguien conectado", async () => {
    gsRows.set("zoe|sentry", { user_sub: "zoe", provider: "sentry", access_token: "z" });
    gsRows.set("david|sentry", { user_sub: "david", provider: "sentry", access_token: "d" });
    local.push({ user_sub: "zoe", provider: "sentry", access_token: null, refresh_token: null, shared: 1 });
    local.push({ user_sub: "david", provider: "sentry", access_token: null, refresh_token: null, shared: 1 });
    expect(await S.resolveConnectorOwner("ana", "sentry")).toEqual({ ownerSub: "david", shared: true });
    gsRows.set("ana|sentry", { user_sub: "ana", provider: "sentry", access_token: "a" });
    S.resetConnectorCacheForTests(); // conectó en otro proceso: pasa el caché
    expect(await S.resolveConnectorOwner("ana", "sentry")).toEqual({ ownerSub: "ana", shared: false });
  });

  it("una compartida cuyo dueño se desconectó o fue expulsado no cuenta", async () => {
    local.push({ user_sub: "david", provider: "sentry", access_token: null, refresh_token: null, shared: 1 });
    expect(await S.resolveConnectorOwner("ana", "sentry")).toBeNull();
    gsRows.set("david|sentry", { user_sub: "david", provider: "sentry", access_token: "d" });
    S.resetConnectorCacheForTests();
    local[0].banned = 1;
    expect(await S.resolveConnectorOwner("ana", "sentry")).toBeNull();
    expect((await S.listSharedConnectors()).size).toBe(0);
  });

  it("compartir crea la marca aunque haya conectado en otro espacio, sin tocar el token", async () => {
    gsRows.set("david|calendly", { user_sub: "david", provider: "calendly", access_token: "c" });
    await S.setConnectorShared("david", "calendly", true);
    expect(local).toEqual([{ user_sub: "david", provider: "calendly", access_token: null, refresh_token: null, shared: 1 }]);
    expect(await S.listAvailableProviders("ana")).toEqual(new Set(["calendly"]));
  });

  it("holders: los de gs de la gente del espacio, más las copias que aún no suben", async () => {
    gsRows.set("ana|github", { user_sub: "ana", provider: "github", access_token: "a" });
    local.push({ user_sub: "ana", provider: "github", access_token: null, refresh_token: null, shared: 0 });
    local.push({ user_sub: "david", provider: "sentry", access_token: "viejo", refresh_token: null, shared: 0 });
    const h = await S.listConnectorHolders();
    expect(h.get("github")).toEqual(["ana"]);
    expect(h.get("sentry")).toEqual(["david"]);
  });
});
