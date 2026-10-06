import { describe, expect, it } from "vitest";
import { roleSkillsLine, touchesUi } from "./factory-roles";

describe("roleSkillsLine", () => {
  it("pide dev-frontend sólo si el pedido toca UI", () => {
    expect(touchesUi("POS táctil del local en el admin (`/vender`)\n- apps/client/src/pages/Vender.jsx")).toBe(true);
    expect(touchesUi("Service y API de ventas\n- apps/server/src/services/sales.ts")).toBe(false);
    expect(roleSkillsLine("build", "apps/client/src/pages/Corte.jsx")).toContain("dev-frontend");
    expect(roleSkillsLine("build", "apps/server/src/routes/sales.ts")).not.toContain("dev-frontend");
  });
  it("nombra las de cada rol y nada para plan o eval", () => {
    const b = roleSkillsLine("build", "");
    for (const s of ["dev-tdd", "dev-test", "dev-verificar"]) expect(b).toContain(s);
    const c = roleSkillsLine("check", "Corte del día en el panel");
    for (const s of ["dev-test", "dev-revision", "dev-verificar", "dev-frontend"]) expect(c).toContain(s);
    expect(roleSkillsLine("plan", "x.tsx")).toBe("");
    expect(roleSkillsLine("eval", "x.tsx")).toBe("");
  });
});
