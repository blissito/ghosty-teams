import { describe, it, expect } from "vitest";
import { openPreview, type OpenPreviewDeps } from "./preview-open.server";

const KEY = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const deps = (over: Partial<OpenPreviewDeps> = {}): OpenPreviewDeps => ({
  runChannel: async () => 7,
  getChannel: async (id) => ({ id }),
  canSee: async () => true,
  resolve: async () => `https://sb-x-3000.preview.test/?k=${KEY}`,
  ...over,
});
const me = { sub: "u1", isOwner: false };

describe("/preview/<id>", () => {
  it("quien ve el room recibe un redirect con la llave en el Location", async () => {
    expect(await openPreview("96", me, deps())).toEqual({ status: 302, location: `https://sb-x-3000.preview.test/?k=${KEY}` });
  });

  it("sin sesión → 401 y nunca pide la llave a gs", async () => {
    let asked = false;
    const r = await openPreview("96", null, deps({ resolve: async () => { asked = true; return "x"; } }));
    expect(r.status).toBe(401);
    expect(asked).toBe(false);
  });

  it("quien no ve el room (o el pedido no existe) → 404, sin pedir la llave", async () => {
    let asked = false;
    const resolve = async () => { asked = true; return "x"; };
    expect((await openPreview("96", me, deps({ canSee: async () => false, resolve }))).status).toBe(404);
    expect((await openPreview("96", me, deps({ runChannel: async () => null, resolve }))).status).toBe(404);
    expect(asked).toBe(false);
  });

  it("un invitado de otro room no entra", async () => {
    const r = await openPreview("96", { sub: "guest:z", isOwner: false }, deps({ canSee: async (_c, sub) => !sub.startsWith("guest:") }));
    expect(r.status).toBe(404);
  });

  it("sin preview lista → 409; id inválido → 404", async () => {
    expect((await openPreview("96", me, deps({ resolve: async () => null }))).status).toBe(409);
    for (const bad of ["abc", "-1", "0", "1.5", ""]) expect((await openPreview(bad, me, deps())).status).toBe(404);
  });

  it("el cuerpo de un error nunca trae la llave", async () => {
    const r = await openPreview("96", me, deps({ resolve: async () => null }));
    expect("body" in r ? r.body : "").not.toContain(KEY);
  });
});

describe("boleto del navegador de un agente", () => {
  it("sin sesión pero con boleto válido: redirige a la preview con llave", async () => {
    const r = await openPreview("184", null, deps({ redeemTicket: (id) => id === 184 }));
    expect(r.status).toBe(302);
  });
  it("sin sesión y sin boleto: 401", async () => {
    const r = await openPreview("184", null, deps({ redeemTicket: () => false }));
    expect(r.status).toBe(401);
  });
});
