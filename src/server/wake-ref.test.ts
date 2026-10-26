import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// La `ref` del despertador es la capacidad que viaja a gs con cada turno: con ella gs le pide a
// Teams que despierte al agente EN un hilo, a nombre de una persona y en un espacio. Lo que
// trae (sub, ns, dest) decide dónde se publica y con qué autoridad, así que nada que no haya
// firmado Teams —un payload editado, otra llave, una ref vencida o incompleta— puede pasar.
vi.mock("../dbq.server", () => ({ dbq: async () => [], num: (v: unknown) => Number(v) }));
vi.mock("./tenant.server", () => ({ withNamespace: async (_ns: string, fn: () => Promise<unknown>) => fn() }));

const { mintWakeRef, verifyWakeRef } = await import("./wakeups.server");

const base = { sub: "ana", ns: "acme", groupId: "c14:root9", dest: { channelId: 14, parentId: 9 } } as never;
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const firma = (payload: string, key = "s3cr3t") => crypto.createHmac("sha256", key).update(`wake.${payload}`).digest("base64url");

beforeEach(() => {
  process.env.GHOSTY_PARTNER_SECRET = "s3cr3t";
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.GHOSTY_PARTNER_SECRET;
});

describe("ref firmada del despertador", () => {
  it("ida y vuelta: lo que se firma es lo que se lee", () => {
    expect(verifyWakeRef(mintWakeRef(base))).toMatchObject({ sub: "ana", ns: "acme", groupId: "c14:root9", dest: { channelId: 14 } });
  });

  it("cambiar el espacio en el payload rompe la firma", () => {
    const [payload, sig] = mintWakeRef(base).split(".");
    const p = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(verifyWakeRef(`${b64({ ...p, ns: "otro" })}.${sig}`)).toBeNull();
  });

  it("firmada con otra llave no pasa", () => {
    const payload = b64({ ...(base as object), exp: Math.floor(Date.now() / 1000) + 60 });
    expect(verifyWakeRef(`${payload}.${firma(payload, "otra")}`)).toBeNull();
  });

  it("vence a los 7 días", () => {
    vi.useFakeTimers();
    const ref = mintWakeRef(base);
    vi.advanceTimersByTime(7 * 24 * 3600_000 - 60_000);
    expect(verifyWakeRef(ref)).not.toBeNull();
    vi.advanceTimersByTime(2 * 60_000);
    expect(verifyWakeRef(ref)).toBeNull();
  });

  it("firmada pero incompleta (sin dest o sin ns) no sirve", () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    for (const p of [{ sub: "ana", ns: "acme", groupId: "g", exp }, { sub: "ana", groupId: "g", dest: {}, exp }]) {
      const payload = b64(p);
      expect(verifyWakeRef(`${payload}.${firma(payload)}`)).toBeNull();
    }
  });

  it("basura, vacío o JSON roto devuelve null sin lanzar", () => {
    for (const r of ["", "x", "x.y", ".", "a.b.c"]) expect(verifyWakeRef(r)).toBeNull();
    const roto = Buffer.from("{no es json").toString("base64url");
    expect(verifyWakeRef(`${roto}.${firma(roto)}`)).toBeNull();
  });

  it("sin GHOSTY_PARTNER_SECRET no se acuña nada (no hay llave vacía por defecto)", () => {
    delete process.env.GHOSTY_PARTNER_SECRET;
    expect(() => mintWakeRef(base)).toThrow(/GHOSTY_PARTNER_SECRET/);
  });
});
