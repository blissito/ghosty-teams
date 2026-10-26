import { describe, it, expect } from "vitest";
import { findingsText } from "./factory-tools.server";

describe("findingsText", () => {
  it("lee `body` y la severidad (palmera #72)", () => {
    const t = findingsText([{ severity: "alta", file: "app/x.ts", line: 3, body: "Falta validar el correo" }]);
    expect(t).toBe("- **alta** `app/x.ts:3` — Falta validar el correo");
  });
  it("interpreta un JSON que llega como texto", () => {
    expect(findingsText('[{"body":"Sin pruebas"}]')).toBe("- Sin pruebas");
  });
  it("nunca regresa el JSON crudo", () => {
    expect(findingsText({ foo: "bar", n: 2 })).not.toMatch(/[{}"]/);
  });
  it("desenvuelve { findings: [...] }", () => {
    expect(findingsText({ findings: [{ message: "a" }, { message: "b" }] })).toBe("- a\n- b");
  });
});
