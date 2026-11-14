import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bareEmail, verifyMailmaskSignature } from "./mailmask-webhook";

const sign = (s: string, ts: string, b: string) => `sha256=${createHmac("sha256", s).update(`${ts}.${b}`).digest("hex")}`;

describe("verifyMailmaskSignature", () => {
  const now = 1_800_000_000_000;
  const ts = String(now);
  const body = '{"event":"email.received"}';
  it("acepta la buena y rechaza alterado, otro secreto, viejo o vacío", () => {
    expect(verifyMailmaskSignature("whsec_a", sign("whsec_a", ts, body), ts, body, now)).toBe(true);
    expect(verifyMailmaskSignature("whsec_a", sign("whsec_a", ts, body), ts, body + " ", now)).toBe(false);
    expect(verifyMailmaskSignature("whsec_b", sign("whsec_a", ts, body), ts, body, now)).toBe(false);
    expect(verifyMailmaskSignature("whsec_a", sign("whsec_a", ts, body), ts, body, now + 600_000)).toBe(false);
    expect(verifyMailmaskSignature("", sign("", ts, body), ts, body, now)).toBe(false);
  });
  it("bareEmail", () => expect(bareEmail("Ana <Ana@X.com>")).toBe("ana@x.com"));
});
