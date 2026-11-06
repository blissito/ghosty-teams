import { describe, expect, it } from "vitest";
import { signRoomPass, verifyRoomPass } from "./invite-pass.server";

// El pase sustituye al código de 6 dígitos: si acepta lo que no debe, cualquiera entra con el
// nombre de otro. Cada caso de abajo es una forma de colarse.
const S = "secreto-de-prueba";
const AHORA = 1_794_000_000;
const base = { ns: "business", room: "random", email: "Ana@Ejemplo.com", name: "Ana", exp: AHORA + 3600 };
const want = { ns: "business", room: "random" };

describe("verifyRoomPass", () => {
  it("un pase bueno entra, con el correo normalizado", () => {
    const p = verifyRoomPass(signRoomPass(base, S), want, AHORA, S);
    expect(p).toMatchObject({ email: "ana@ejemplo.com", name: "Ana", room: "random" });
  });

  it("caducado no entra", () => {
    expect(verifyRoomPass(signRoomPass({ ...base, exp: AHORA - 1 }, S), want, AHORA, S)).toBeNull();
  });

  it("de otro espacio o de otro room no entra", () => {
    const t = signRoomPass(base, S);
    expect(verifyRoomPass(t, { ns: "otro", room: "random" }, AHORA, S)).toBeNull();
    expect(verifyRoomPass(t, { ns: "business", room: "general" }, AHORA, S)).toBeNull();
  });

  it("firmado con otro secreto o con el payload cambiado no entra", () => {
    expect(verifyRoomPass(signRoomPass(base, "otro"), want, AHORA, S)).toBeNull();
    const [, sig] = signRoomPass(base, S).split(".");
    const otro = Buffer.from(JSON.stringify({ w: "business", r: "random", e: "yo@x.com", n: "Yo", x: AHORA + 9 })).toString("base64url");
    expect(verifyRoomPass(`${otro}.${sig}`, want, AHORA, S)).toBeNull();
  });

  it("sin secreto en el servidor nunca entra nadie", () => {
    expect(verifyRoomPass(signRoomPass(base, ""), want, AHORA, "")).toBeNull();
  });

  it("basura no truena", () => {
    for (const t of [undefined, null, "", ".", "abc", "x.y", "a".repeat(3000)]) expect(verifyRoomPass(t, want, AHORA, S)).toBeNull();
  });
});
