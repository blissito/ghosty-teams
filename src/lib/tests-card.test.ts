import { describe, expect, it } from "vitest";
import { bubbleWithoutEbDoc, extractTests, stripTests } from "./ebdoc";

const card = (extra = "") => `Corrí la suite. Tres fallos, dos son de configuración.

\`\`\`gt-tests
{"repo":"acme/api","ref":"main","sha":"abc1234def567890","command":"npm test","passed":142,"failed":3,"skipped":2,"duration":38,"failures":[{"test":"mailer › subject","message":"expected 'Hola' to equal 'Hello'"}]}
\`\`\`${extra}`;

describe("gt-tests", () => {
  it("saca los datos y recorta el sha a 12", () => {
    const t = extractTests(card())!;
    expect(t.repo).toBe("acme/api");
    expect(t.passed).toBe(142);
    expect(t.failed).toBe(3);
    expect(t.command).toBe("npm test");
    expect(t.sha).toBe("abc1234def56");
  });

  it("acepta el CERO — una suite donde todo falla tiene passed 0", () => {
    const t = extractTests('```gt-tests\n{"repo":"a/b","passed":0,"failed":9}\n```')!;
    expect(t.passed).toBe(0);
    expect(t.failed).toBe(9);
  });

  it("sin repo o sin ningún conteo NO pinta tarjeta", () => {
    expect(extractTests('```gt-tests\n{"passed":5}\n```')).toBeNull();
    expect(extractTests('```gt-tests\n{"repo":"a/b","command":"npm test"}\n```')).toBeNull();
  });

  it("no pinta media tarjeta si el fence sigue abierto", () => {
    expect(extractTests('```gt-tests\n{"repo":"a/b","passed":1')).toBeNull();
  });

  it("un fallo sin `test` se descarta sin reventar la tarjeta", () => {
    const t = extractTests(
      '```gt-tests\n{"repo":"a/b","failed":1,"failures":[{"message":"solo mensaje"},{"test":"x","message":"ok"}]}\n```',
    )!;
    expect(t.failures).toEqual([{ test: "x", message: "ok" }]);
  });

  it("el JSON no llega al bubble, pero el diagnóstico SÍ se queda", () => {
    const b = bubbleWithoutEbDoc(card());
    expect(b).toContain("Corrí la suite");
    expect(b).not.toContain("gt-tests");
    expect(b).not.toContain("npm test");
  });

  it("stripTests conserva lo de antes y lo de después del fence", () => {
    expect(stripTests(card("\n\n¿Lo arreglo?"))).toBe(
      "Corrí la suite. Tres fallos, dos son de configuración.\n\n¿Lo arreglo?",
    );
  });
});
