import { describe, expect, it } from "vitest";
import { createWarmGate } from "./warm-native.server";

// El «escribiendo…» llega cada 2 s: sin freno cada ping sería un POST a gs y lecturas de DB.
describe("createWarmGate", () => {
  it("deja pasar uno por conversación dentro de la ventana", () => {
    const g = createWarmGate(60_000);
    expect(g.take("ns:dm:4", 0)).toBe(true);
    expect(g.take("ns:dm:4", 2_000)).toBe(false);
    expect(g.take("ns:dm:4", 59_999)).toBe(false);
    expect(g.take("ns:dm:4", 60_000)).toBe(true);
  });
  it("conversaciones y espacios distintos no se frenan entre sí", () => {
    const g = createWarmGate(60_000);
    expect(g.take("a:dm:4", 0)).toBe(true);
    expect(g.take("b:dm:4", 1)).toBe(true);
    expect(g.take("a:room:7:12", 2)).toBe(true);
  });
});
