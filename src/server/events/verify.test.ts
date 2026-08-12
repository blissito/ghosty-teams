import { describe, expect, it } from "vitest";
import { checkCode, hashCode, newCode, normalizeEmail, validEmail, VERIFY_MAX_INTENTOS } from "./verify.server";

// El código de 6 dígitos es lo único que separa "un correo que alguien tecleó" de "un
// correo que existe y es suyo". De eso dependen dos cosas: que el baneo por correo sirva
// de algo (antes se saltaba escribiendo otro) y que la lista de suscriptores —el producto
// de abrir un room— no sea basura.

const AHORA = 1_000_000;
const fila = (over: Partial<Parameters<typeof checkCode>[0]> = {}) => ({
  verify_code_hash: hashCode("123456"),
  verify_expires_at: AHORA + 600,
  verify_attempts: 0,
  ...over,
});

describe("checkCode", () => {
  it("el código correcto pasa", () => {
    expect(checkCode(fila(), "123456", AHORA)).toEqual({ ok: true });
  });

  it("tolera espacios alrededor — se copia y pega desde el correo", () => {
    expect(checkCode(fila(), "  123456 ", AHORA)).toEqual({ ok: true });
  });

  it("uno incorrecto no pasa", () => {
    expect(checkCode(fila(), "000000", AHORA)).toEqual({ ok: false, reason: "incorrecto" });
  });

  it("caducado no pasa, ni siquiera siendo el correcto", () => {
    expect(checkCode(fila({ verify_expires_at: AHORA - 1 }), "123456", AHORA)).toEqual({
      ok: false,
      reason: "caducado",
    });
  });

  it("sin código pedido no pasa nada", () => {
    expect(checkCode(fila({ verify_code_hash: null }), "123456", AHORA)).toEqual({
      ok: false,
      reason: "sin-codigo",
    });
  });

  it("agotados los intentos, ni el código correcto entra", () => {
    // Seis dígitos son un millón de combinaciones: sin tope se fuerzan en minutos.
    expect(checkCode(fila({ verify_attempts: VERIFY_MAX_INTENTOS }), "123456", AHORA)).toEqual({
      ok: false,
      reason: "agotado",
    });
  });

  it("el tope se comprueba ANTES de comparar", () => {
    // Si se comparara primero, cada intento seguiría diciendo "frío/caliente" por más que
    // el contador estuviera al tope. Con el orden correcto, un código caducado Y agotado
    // responde "agotado" — el estado más restrictivo gana.
    const f = fila({ verify_attempts: VERIFY_MAX_INTENTOS, verify_expires_at: AHORA - 1 });
    expect(checkCode(f, "000000", AHORA)).toEqual({ ok: false, reason: "agotado" });
  });
});

describe("hashCode", () => {
  it("no guarda el código en claro", () => {
    expect(hashCode("123456")).not.toContain("123456");
  });

  it("dos códigos distintos dan hashes distintos", () => {
    expect(hashCode("123456")).not.toBe(hashCode("123457"));
  });
});

describe("newCode", () => {
  it("siempre son SEIS dígitos, ceros a la izquierda incluidos", () => {
    // `String(n)` de un número chico daría "42": el campo pide 6 y la persona no podría
    // enviarlo nunca. Es un fallo que sólo aparece 1 de cada ~10.000 veces.
    for (let i = 0; i < 400; i++) expect(newCode()).toMatch(/^\d{6}$/);
  });
});

describe("validEmail", () => {
  it("acepta lo razonable y rechaza lo que no es un correo", () => {
    expect(validEmail("Ana.Ruiz+eventos@Example.com")).toBe(true);
    expect(validEmail("sin-arroba.com")).toBe(false);
    expect(validEmail("dos@@arrobas.com")).toBe(false);
    expect(validEmail("sin@tld")).toBe(false);
    expect(validEmail(`${"a".repeat(200)}@x.com`)).toBe(false);
  });

  it("normaliza a minúsculas y sin espacios", () => {
    // La clave única de la tabla es (channel_id, email): sin normalizar, "Ana@x.com" y
    // "ana@x.com" serían dos personas, y banear a una dejaría entrar a la otra.
    expect(normalizeEmail("  Ana@X.com ")).toBe("ana@x.com");
  });
});
