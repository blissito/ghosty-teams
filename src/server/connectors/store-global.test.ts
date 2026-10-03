import { beforeEach, describe, expect, it, vi } from "vitest";

// Conexiones globales en gs + marca «compartida» por espacio (store.server.ts, 2026-10-03).
// gs se simula con un mapa (`gsRows`) detrás de `call`; el espacio, con filas en memoria
// detrás de `dbq` (sólo las consultas que usa el store).
type Row = { user_sub: string; provider: string; access_token: string | null; refresh_token: string | null; shared: number; banned?: number; account?: string | null };
let gsRows: Map<string, any>;
const localOf = () => { if (!porEspacio.has(ns)) porEspacio.set(ns, []); return porEspacio.get(ns)!; };
let local: Row[];
let gsDown: boolean;
const k = (s: string, p: string) => `${s}|${p}`;

let ns = "esp-a";
vi.mock("../tenant.server", () => ({ currentNamespace: async () => ns }));
// Cada espacio tiene sus filas locales (marcas): se simula con una tabla por namespace.
const porEspacio = new Map<string, Row[]>();

vi.mock("./studio-bridge.server", () => ({
  call: async (sub: string, b: any) => {
    if (gsDown) return null;
    if (b.action === "cred.get") {
      const mine = [...gsRows.values()].filter((r) => r.user_sub === sub && r.provider === b.provider);
      // Como gs: cuenta pedida → ésa o ninguna; sin cuenta → la más reciente.
      if (typeof b.account === "string") return { ok: true, row: mine.find((r) => (r.account ?? "") === b.account) ?? null };
      return { ok: true, row: mine[mine.length - 1] ?? null };
    }
    if (b.action === "cred.set") {
      const account = typeof b.account === "string" ? b.account : b.externalId ?? "";
      // Si ya existía la llave, se re-inserta al final (= la más reciente).
      gsRows.delete(k(sub, b.provider) + "|" + account);
      gsRows.set(k(sub, b.provider) + "|" + account, { user_sub: sub, provider: b.provider, access_token: b.accessToken, refresh_token: b.refreshToken ?? null, expires_at: null, external_id: b.externalId ?? null, meta: null, meta_at: null, account });
      return { ok: true, written: true, account };
    }
    if (b.action === "cred.delete") {
      for (const [key, r] of gsRows) if (r.user_sub === sub && r.provider === b.provider && (typeof b.account !== "string" || (r.account ?? "") === b.account)) gsRows.delete(key);
      return { ok: true };
    }
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
    let local = localOf();
    const q = sql.replace(/\s+/g, " ");
    const banned = (s: string) => local.some((r) => r.user_sub === s && r.banned);
    if (q.startsWith("SELECT user_sub, provider, access_token")) return local.filter((r) => r.user_sub === p[0] && r.provider === p[1]);
    if (q.startsWith("SELECT account FROM gc_user_connectors")) return local.filter((r) => r.user_sub === p[0] && r.provider === p[1]).map((r) => ({ account: r.account ?? null }));
    if (q.startsWith("UPDATE gc_user_connectors SET account=?")) { for (const r of local) if (r.user_sub === p[1] && r.provider === p[2] && (!q.includes("account IS NULL") || r.account == null)) r.account = p[0]; return []; }
    if (q.startsWith("UPDATE gc_user_connectors SET access_token=NULL")) { for (const r of local) if (r.user_sub === p[0] && r.provider === p[1]) { r.access_token = null; r.refresh_token = null; } return []; }
    if (q.startsWith("INSERT INTO gc_user_connectors (user_sub, provider, access_token, created_at)")) { if (!local.some((r) => r.user_sub === p[0] && r.provider === p[1])) local.push({ user_sub: p[0], provider: p[1], access_token: null, refresh_token: null, shared: 0 }); return []; }
    if (q.startsWith("UPDATE gc_user_connectors SET shared=?")) { for (const r of local) if (r.user_sub === p[1] && r.provider === p[2]) r.shared = p[0]; return []; }
    if (q.startsWith("SELECT c.user_sub FROM gc_user_connectors c")) return local.filter((r) => r.provider === p[0] && r.shared && !banned(r.user_sub) && r.user_sub !== p[1]).sort((a, b) => a.user_sub.localeCompare(b.user_sub));
    if (q.startsWith("SELECT c.user_sub, c.provider FROM gc_user_connectors c")) return local.filter((r) => r.shared && !banned(r.user_sub)).sort((a, b) => a.user_sub.localeCompare(b.user_sub));
    if (q.startsWith("SELECT provider FROM gc_user_connectors WHERE user_sub=? AND access_token IS NOT NULL")) return local.filter((r) => r.user_sub === p[0] && r.access_token);
    if (q.startsWith("SELECT sub FROM gc_users")) return [...new Set(local.map((r) => r.user_sub))].filter((s) => !banned(s)).map((sub) => ({ sub }));
    if (q.startsWith("SELECT user_sub, provider FROM gc_user_connectors WHERE access_token IS NOT NULL")) return local.filter((r) => r.access_token);
    if (q.startsWith("DELETE FROM gc_user_connectors")) { for (let i = local.length - 1; i >= 0; i--) if (local[i].user_sub === p[0] && local[i].provider === p[1]) local.splice(i, 1); return []; }
    return [];
  },
  dbqMany: vi.fn(),
  num: (v: unknown) => Number(v),
}));

const S = await import("./store.server");

beforeEach(() => {
  gsRows = new Map();
  porEspacio.clear();
  ns = "esp-a";
  local = localOf();
  gsDown = false;
  S.resetConnectorCacheForTests();
});

describe("conexión global", () => {
  it("conectar en un espacio la deja en gs y el espacio guarda sólo la marca", async () => {
    await S.setConnectorRow({ sub: "ana", provider: "github", accessToken: "tok" });
    expect([...gsRows.values()].find((r) => r.provider === "github").access_token).toBe("tok");
    expect(local).toMatchObject([{ user_sub: "ana", provider: "github", access_token: null, refresh_token: null, shared: 0, account: "" }]);
    expect((await S.getConnectorRow("ana", "github"))?.access_token).toBe("tok");
  });

  it("una copia vieja del espacio sube a gs la primera vez que se lee", async () => {
    local.push({ user_sub: "ana", provider: "sentry", access_token: "viejo", refresh_token: "r", shared: 1 });
    expect((await S.getConnectorRow("ana", "sentry"))?.access_token).toBe("viejo");
    expect([...gsRows.values()].find((r) => r.provider === "sentry").access_token).toBe("viejo");
    expect(local[0]).toMatchObject({ access_token: null, shared: 1 }); // la marca compartida sobrevive
  });

  it("si gs no contesta, se usa la copia del espacio como antes", async () => {
    gsDown = true;
    local.push({ user_sub: "ana", provider: "odoo", access_token: "k", refresh_token: null, shared: 0 });
    expect((await S.getConnectorRow("ana", "odoo"))?.access_token).toBe("k");
    expect(local[0].access_token).toBe("k");
  });

  it("una copia local CON token (gs no alcanzó a guardar un refresco) gana sobre la de gs y se sube", async () => {
    gsRows.set("ana|github", { user_sub: "ana", provider: "github", access_token: "viejo", refresh_token: "r-viejo" });
    local.push({ user_sub: "ana", provider: "github", access_token: "nuevo", refresh_token: "r-nuevo", shared: 0 });
    expect((await S.getConnectorRow("ana", "github"))?.refresh_token).toBe("r-nuevo");
    expect([...gsRows.values()].filter((r) => r.provider === "github").pop().access_token).toBe("nuevo");
  });

  it("desconectar sin gs no borra la marca (no queda a medias) y avisa", async () => {
    local.push({ user_sub: "ana", provider: "github", access_token: null, refresh_token: null, shared: 1 });
    gsDown = true;
    await expect(S.deleteConnectorRow("ana", "github")).rejects.toThrow(/no contestó/);
    expect(local.length).toBe(1);
  });

  it("desconectar borra en gs y la marca del espacio", async () => {
    await S.setConnectorRow({ sub: "ana", provider: "github", accessToken: "tok" });
    await S.deleteConnectorRow("ana", "github");
    expect([...gsRows.values()].some((r) => r.provider === "github")).toBe(false);
    expect(local).toMatchObject([{ provider: "github", access_token: null, account: "" }]); // lápida
    expect(await S.getConnectorRow("ana", "github")).toBeNull();
  });
});

describe("varias cuentas por conector", () => {
  it("conectar la cuenta B en otro espacio no le cambia la A a este espacio, y conviven", async () => {
    await S.setConnectorRow({ sub: "ana", provider: "odoo", accessToken: "tok-A", externalId: "cliente-a" });
    // Otro espacio conecta la del cliente B: en gs conviven las dos (y B es la más reciente).
    gsRows.set("ana|odoo|cliente-b", { user_sub: "ana", provider: "odoo", access_token: "tok-B", account: "cliente-b" });
    S.resetConnectorCacheForTests();
    expect((await S.getConnectorRow("ana", "odoo"))?.access_token).toBe("tok-A"); // este espacio fijó A
    expect([...gsRows.values()].filter((r) => r.provider === "odoo").length).toBe(2);
  });

  it("dos espacios con cuentas distintas no se cruzan aunque la caché esté caliente", async () => {
    ns = "esp-a";
    await S.setConnectorRow({ sub: "ana", provider: "odoo", accessToken: "tok-A", externalId: "a" });
    ns = "esp-b";
    await S.setConnectorRow({ sub: "ana", provider: "odoo", accessToken: "tok-B", externalId: "b" });
    ns = "esp-a";
    expect((await S.getConnectorRow("ana", "odoo"))?.access_token).toBe("tok-A");
    ns = "esp-b";
    expect((await S.getConnectorRow("ana", "odoo"))?.access_token).toBe("tok-B");
    ns = "esp-a";
    expect((await S.getConnectorRow("ana", "odoo"))?.access_token).toBe("tok-A");
  });

  it("un espacio sin cuenta fijada usa la más reciente y la fija", async () => {
    gsRows.set("ana|odoo|a", { user_sub: "ana", provider: "odoo", access_token: "tok-A", account: "a" });
    local.push({ user_sub: "ana", provider: "odoo", access_token: null, refresh_token: null, shared: 0, account: null });
    expect((await S.getConnectorRow("ana", "odoo"))?.access_token).toBe("tok-A");
    expect(local[0].account).toBe("a");
  });

  it("desconectar aquí NO hace que este espacio caiga a la cuenta de otro cliente", async () => {
    await S.setConnectorRow({ sub: "ana", provider: "odoo", accessToken: "tok-B", externalId: "b" });
    gsRows.set("ana|odoo|a", { user_sub: "ana", provider: "odoo", access_token: "tok-A", account: "a" });
    await S.deleteConnectorRow("ana", "odoo");
    expect(await S.getConnectorRow("ana", "odoo")).toBeNull();
    expect((await S.listConnectorProviders("ana")).has("odoo")).toBe(false);
  });

  it("desconectar quita sólo la cuenta de este espacio", async () => {
    await S.setConnectorRow({ sub: "ana", provider: "odoo", accessToken: "tok-A", externalId: "a" });
    gsRows.set("ana|odoo|b", { user_sub: "ana", provider: "odoo", access_token: "tok-B", account: "b" });
    await S.deleteConnectorRow("ana", "odoo");
    expect([...gsRows.values()].map((r) => r.account)).toEqual(["b"]);
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
    expect(local).toMatchObject([{ user_sub: "david", provider: "calendly", access_token: null, refresh_token: null, shared: 1 }]);
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
