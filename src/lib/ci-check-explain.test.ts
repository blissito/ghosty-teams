import { describe, expect, it } from "vitest";
import { checkSentence, explainCheck } from "./ci-check-explain";

describe("explainCheck", () => {
  it("reconoce los checks típicos", () => {
    expect(explainCheck("security")?.text).toMatch(/vulnerabilidades/);
    expect(explainCheck("docker")?.text).toMatch(/imagen de producción/);
    expect(explainCheck("verify")?.text).toMatch(/pruebas/);
  });
  it("el sufijo dice sobre qué parte corre", () => {
    const e = explainCheck("verify-cli")!;
    expect(checkSentence(e, (x) => x)).toBe("Corre las pruebas y el typecheck del proyecto (cli).");
  });
  it("no inventa con nombres desconocidos", () => {
    expect(explainCheck("label-sync")).toBeNull();
  });
});
