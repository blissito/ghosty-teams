import { describe, it, expect } from "vitest";
import { kindSummary, parseKindMeta, runKindTag } from "./factory-kinds";

describe("etiqueta del pedido por tipo", () => {
  it("seguridad con conteo", () => {
    expect(runKindTag("security", { alerts: 3 })).toEqual({ icon: "🛡️", text: "Seguridad: {n} alertas", n: 3 });
    expect(runKindTag("security", { alerts: 1 })?.text).toBe("Seguridad: 1 alerta");
    expect(runKindTag("security", null)?.text).toBe("Seguridad: lote de alertas");
  });
  it("arreglos de CI y de dependencias con el número del PR", () => {
    expect(runKindTag("ci_fix", null, "https://github.com/a/b/pull/12")).toEqual({ icon: "🔧", text: "Arreglo de CI de #{n}", n: 12 });
    expect(runKindTag("dep_fix", null, "https://github.com/a/b/pull/7")?.text).toBe("Arreglo de dependencia de #{n}");
    expect(runKindTag("ci_fix", null, null)?.text).toBe("Arreglo de CI");
  });
  it("los demás no llevan etiqueta", () => {
    expect(runKindTag(null, null)).toBeNull();
    expect(runKindTag("dependabot", null)).toBeNull();
    expect(runKindTag("sprint", null)).toBeNull();
  });
  it("resumen serializable", () => {
    expect(kindSummary(parseKindMeta('{"alerts":2,"covered":[{"alert":"dependabot#1","pr":34}]}'))).toEqual({ alerts: 2, covered: 1 });
    expect(kindSummary(parseKindMeta("roto"))).toBeNull();
  });
});
