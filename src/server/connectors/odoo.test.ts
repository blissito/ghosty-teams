import { describe, it, expect, vi, beforeEach } from "vitest";

// El guard de red se prueba aparte (net-guard.test.ts); aquí se sustituye por un fetch
// controlado para poder ejercitar el protocolo y la traducción de errores.
const calls: any[] = [];
let reply: any = { result: true };
vi.mock("./net-guard.server", () => ({
  guardedFetch: async (_origin: string, _path: string, init: any) => {
    calls.push(JSON.parse(init.body));
    const r = typeof reply === "function" ? reply(calls.length) : reply;
    if (r === "__HTML__") return { status: 200, body: "<!doctype html><html><body>hola</body></html>" };
    return { status: r.__status ?? 200, body: JSON.stringify(r) };
  },
  assertPublicOrigin: async (u: string) => u,
}));

const creds = {
  // Longitud realista: las API keys de Odoo son cadenas largas, y la redacción sólo actúa
  // a partir de 8 caracteres (con menos destrozaría el mensaje — hay un test abajo).
  secret: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  fields: { url: "https://acme.odoo.com", db: "acme", login: "ana@acme.com" },
  origin: "https://acme.odoo.com",
  externalId: "7",
  probe: { uid: 7, version: "17.0" },
};
let credsOrNull: any = creds;
vi.mock("./credentials.server", () => ({
  getCredentials: async () => credsOrNull,
  notConnected: (n: string) => ({ error: `La cuenta de ${n} no está conectada...` }),
}));

import { tools, ambientContext, verifyCredentials } from "./odoo.server";
const byName = (n: string) => tools.find((t) => t.name === n)!;

beforeEach(() => {
  calls.length = 0;
  reply = { result: true };
  credsOrNull = creds;
});

describe("protocolo", () => {
  it("arma el envelope execute_kw con db, uid y la key", async () => {
    reply = { result: [{ id: 1, name: "Acme" }] };
    await byName("odoo_search_read").handler("u1", { model: "res.partner" });
    expect(calls[0].params.service).toBe("object");
    expect(calls[0].params.method).toBe("execute_kw");
    expect(calls[0].params.args.slice(0, 5)).toEqual([
      "acme",
      7,
      "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      "res.partner",
      "search_read",
    ]);
  });

  it("aplica el tope de filas aunque pidan miles", async () => {
    reply = { result: [] };
    await byName("odoo_search_read").handler("u1", { model: "crm.lead", limit: 9999 });
    expect(calls[0].params.args[6].limit).toBe(200);
  });
});

describe("errores traducidos — los lee el modelo, así que dicen qué hacer", () => {
  it("credenciales malas", async () => {
    reply = { error: { data: { name: "odoo.exceptions.AccessDenied", message: "Access denied" } } };
    const r: any = await byName("odoo_count").handler("u1", { model: "crm.lead" });
    expect(r.error).toMatch(/base de datos|API key/i);
  });

  it("falta de permisos nombra el módulo, no un 403", async () => {
    reply = { error: { data: { name: "odoo.exceptions.AccessError", message: "no access to crm.lead" } } };
    const r: any = await byName("odoo_count").handler("u1", { model: "crm.lead" });
    expect(r.error).toMatch(/permiso/i);
    expect(r.error).not.toMatch(/^403/);
  });

  it("un ValidationError conserva el texto de Odoo, que dice qué campo falta", async () => {
    reply = { error: { data: { name: "odoo.exceptions.ValidationError", message: "Campo partner_id: se esperaba un entero" } } };
    const r: any = await byName("odoo_create").handler("u1", { model: "crm.lead", values: { partner_id: "Acme" } });
    expect(r.error).toContain("partner_id");
  });

  it("nunca deja escapar la API key en el texto de un error", async () => {
    reply = { error: { message: "fallo con la llave a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 dentro" } };
    const r: any = await byName("odoo_count").handler("u1", { model: "crm.lead" });
    expect(r.error).not.toContain("a1b2c3d4e5f6");
  });

  it("una base de datos inexistente NO filtra la infraestructura de Odoo", async () => {
    // Odoo no lo manda como AccessDenied: deja salir el error crudo de su Postgres, con la
    // IP y el puerto internos dentro. Medido contra www.odoo.com el 2026-08-25.
    reply = {
      error: {
        data: {
          message: 'connection to server at "10.1.0.14", port 5432 failed: FATAL:  database "no-existe" does not exist',
        },
      },
    };
    const r: any = await byName("odoo_count").handler("u1", { model: "crm.lead" });
    expect(r.error).toMatch(/base de datos "no-existe"/);
    expect(r.error).not.toMatch(/10\.1\.0\.14|5432|FATAL/);
  });

  it("una página web en vez de JSON se explica, no se vuelca", async () => {
    reply = "__HTML__";
    const r: any = await byName("odoo_count").handler("u1", { model: "crm.lead" });
    expect(r.error).toMatch(/página web/i);
    expect(r.error).not.toMatch(/<html|<!doctype/i);
  });

  it("una key CORTA no destroza el mensaje al redactarla", async () => {
    // `split/join` con un secreto de un carácter sustituye todas sus apariciones y deja el
    // texto ilegible — peor que no redactar. Visto en el humo real contra Odoo.
    credsOrNull = { ...creds, secret: "k" };
    reply = { error: { message: "no se pudo konectar al stok" } };
    const r: any = await byName("odoo_count").handler("u1", { model: "crm.lead" });
    expect(r.error).toContain("konectar");
    expect(r.error).not.toContain("«api key»");
  });

  it("un handler NUNCA lanza: sin conexión devuelve {error}", async () => {
    credsOrNull = null;
    const r: any = await byName("odoo_search_read").handler("u1", { model: "crm.lead" });
    expect(r.error).toBeTruthy();
  });
});

describe("límites de escritura", () => {
  it("rechaza un write masivo", async () => {
    const ids = Array.from({ length: 51 }, (_, i) => i + 1);
    const r: any = await byName("odoo_write").handler("u1", { model: "crm.lead", ids, values: { probability: 60 } });
    expect(r.error).toMatch(/demasiados/i);
    expect(calls.length).toBe(0);
  });

  it("rechaza un modelo que no tiene forma de modelo de Odoo", async () => {
    const r: any = await byName("odoo_search_read").handler("u1", { model: "'; DROP" });
    expect(r.error).toMatch(/modelo/i);
    expect(calls.length).toBe(0);
  });

  it("rechaza un filtro mal formado en vez de mandárselo a Odoo", async () => {
    const r: any = await byName("odoo_search_read").handler("u1", { model: "crm.lead", domain: [["name", "ilike"]] });
    expect(r.error).toMatch(/condición|filtro/i);
    expect(calls.length).toBe(0);
  });
});

describe("borrar no existe; archivar sí", () => {
  it("no hay ninguna tool que borre", () => {
    const names = tools.map((t) => t.name).join(" ");
    expect(names).not.toMatch(/unlink|delete|borrar/i);
  });

  it("archivar es un write de active:false, reversible con restore", async () => {
    await byName("odoo_archive").handler("u1", { model: "crm.lead", ids: [3] });
    expect(calls[0].params.args[4]).toBe("write");
    expect(calls[0].params.args[5][1]).toEqual({ active: false });
    calls.length = 0;
    await byName("odoo_archive").handler("u1", { model: "crm.lead", ids: [3], restore: true });
    expect(calls[0].params.args[5][1]).toEqual({ active: true });
  });
});

describe("listado de tools", () => {
  it("todas llevan el prefijo del conector y no pisan familias ajenas", () => {
    for (const t of tools) expect(t.name.startsWith("odoo_")).toBe(true);
  });
  it("es una lista constante, así no puede variar por hilo ni por canal", () => {
    expect(Array.isArray(tools)).toBe(true);
  });
});

describe("verifyCredentials", () => {
  it("acepta y captura el uid para no re-loguear en cada turno", async () => {
    let n = 0;
    reply = () => (++n === 1 ? { result: 7 } : { result: { server_version: "17.0" } });
    const r: any = await verifyCredentials({ url: "https://acme.odoo.com", db: "acme", login: "ana@acme.com", apiKey: "K" });
    expect(r.ok).toBe(true);
    expect(r.externalId).toBe("7");
    expect(r.probe.uid).toBe(7);
  });

  it("un login false apunta a la base de datos, que es donde más se falla", async () => {
    reply = { result: false };
    const r: any = await verifyCredentials({ url: "https://acme.odoo.com", db: "mal", login: "ana@acme.com", apiKey: "K" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/base de datos/i);
  });
});

describe("ambientContext", () => {
  it("dice con qué usuario actúa — importa cuando la conexión es del equipo", async () => {
    const ctx = (await ambientContext("u1", "Ana", "¿cuántos leads hay?", null)) ?? "";
    expect(ctx).toContain("ana@acme.com");
    expect(ctx).toContain("acme");
    expect(ctx).toMatch(/archiva/i);
    expect(ctx).toContain("crm.lead");
  });
  it("sin conexión no mete nada en el prompt", async () => {
    credsOrNull = null;
    expect(await ambientContext("u1", "Ana", "hola", null)).toBeNull();
  });
});
