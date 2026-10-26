import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalGet, partnerRequestOk, partnerSigOk } from "./partner-sig.server";

// La firma de partner de `api/internal/*` cubre el CUERPO: la misma firma con otro cuerpo no
// pasa. Con el literal viejo (`ts.members-admin`) una firma capturada servía 5 min para
// cualquier cuerpo, y en prospeccion-run para publicar en el bus de otro espacio (26-oct).
const SECRET = "s3cr3t";
const sign = (ts: string, raw: string, key = SECRET) => crypto.createHmac("sha256", key).update(`${ts}.${raw}`).digest("hex");
const now = () => String(Math.floor(Date.now() / 1000));

beforeEach(() => {
  process.env.GHOSTY_PARTNER_SECRET = SECRET;
});
afterEach(() => {
  delete process.env.GHOSTY_PARTNER_SECRET;
  vi.useRealTimers();
});

describe("partnerSigOk", () => {
  it("la firma del cuerpo pasa", () => {
    const ts = now();
    expect(partnerSigOk(ts, sign(ts, '{"a":1}'), '{"a":1}')).toBe(true);
  });

  it("la MISMA firma con un cuerpo distinto no pasa", () => {
    const ts = now();
    const sig = sign(ts, '{"ns":"acme","sub":"u1"}');
    expect(partnerSigOk(ts, sig, '{"ns":"otro","sub":"u1"}')).toBe(false);
    expect(partnerSigOk(ts, sig, "")).toBe(false);
  });

  it("otro secreto, ts cambiado, vieja (>300 s) o del futuro: no pasa", () => {
    const ts = now();
    expect(partnerSigOk(ts, sign(ts, "x", "otro"), "x")).toBe(false);
    expect(partnerSigOk(String(Number(ts) + 1), sign(ts, "x"), "x")).toBe(false);
    const viejo = String(Number(ts) - 301);
    expect(partnerSigOk(viejo, sign(viejo, "x"), "x")).toBe(false);
    const futuro = String(Number(ts) + 301);
    expect(partnerSigOk(futuro, sign(futuro, "x"), "x")).toBe(false);
  });

  it("vacío, basura o sin secreto: no pasa y no lanza", () => {
    const ts = now();
    expect(partnerSigOk("", sign("", "x"), "x")).toBe(false);
    expect(partnerSigOk("abc", sign("abc", "x"), "x")).toBe(false);
    expect(partnerSigOk(ts, "", "x")).toBe(false);
    expect(partnerSigOk(ts, "zz", "x")).toBe(false);
    delete process.env.GHOSTY_PARTNER_SECRET;
    expect(partnerSigOk(ts, sign(ts, "x", ""), "x")).toBe(false);
  });
});

describe("partnerRequestOk y GET", () => {
  it("lee x-ghosty-ts / x-ghosty-sig", () => {
    const ts = now();
    const raw = '{"x":1}';
    const req = new Request("http://t/api/internal/alert", { method: "POST", headers: { "x-ghosty-ts": ts, "x-ghosty-sig": sign(ts, raw) }, body: raw });
    expect(partnerRequestOk(req, raw)).toBe(true);
    expect(partnerRequestOk(req, '{"x":2}')).toBe(false);
  });

  it("la firma de un GET es de SU ruta: no sirve en otra", () => {
    const ts = now();
    const sig = sign(ts, canonicalGet("/api/internal/members"));
    const h = { "x-ghosty-ts": ts, "x-ghosty-sig": sig };
    expect(partnerRequestOk(new Request("http://t/api/internal/members", { headers: h }), canonicalGet("/api/internal/members"))).toBe(true);
    expect(partnerRequestOk(new Request("http://t/api/internal/announcements", { headers: h }), canonicalGet("/api/internal/announcements"))).toBe(false);
  });
});
