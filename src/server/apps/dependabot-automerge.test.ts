import { describe, it, expect } from "vitest";
import { blocksAutoMerge } from "./dependabot.server";

// Switch por repo (29-oct): los majors esperaban a una persona para siempre (business: 7 en revisión
// de 2 a 9 días). Con `major_auto` entran como un minor; un salto desconocido sigue esperando.
describe("blocksAutoMerge", () => {
  it("patch y minor nunca bloquean", () => {
    expect(blocksAutoMerge("dependabot:patch")).toBe(false);
    expect(blocksAutoMerge("dependabot:minor")).toBe(false);
  });
  it("major bloquea sin el switch y entra con él", () => {
    expect(blocksAutoMerge("dependabot:major")).toBe(true);
    expect(blocksAutoMerge("dependabot:major", true)).toBe(false);
  });
  it("un salto desconocido bloquea aunque el switch esté prendido", () => {
    expect(blocksAutoMerge("dependabot:unknown", true)).toBe(true);
  });
  it("un pedido que no es de Dependabot no bloquea", () => {
    expect(blocksAutoMerge(null)).toBe(false);
    expect(blocksAutoMerge("issue:12")).toBe(false);
  });
});
