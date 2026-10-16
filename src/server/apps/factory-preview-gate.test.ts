import { describe, it, expect } from "vitest";
import { acceptanceSection, envRiskLine, planAsksPreview, previewRequiredFrom, previewGateBlock, previewViabilityLine } from "./factory-preview-gate";

// El plan v2 del #96 (resumido): el criterio decía «en la preview del PR».
const PLAN_96 = `# Subir React Router a 8
**Listo cuando:** la app corre en RR8.
## Problema
RR7 queda sin soporte.
## Criterios de aceptación
- Typecheck y build pasan.
- La reserva pública de un servicio se completa de punta a punta en la preview del PR.
## Pasos
1. Aplicar la guía 7→8.
## Riesgos y fuera de alcance
El deploy es inmediato.`;

describe("planAsksPreview", () => {
  it("lee sólo la sección de criterios", () => {
    expect(acceptanceSection(PLAN_96)).toContain("reserva pública");
    expect(acceptanceSection(PLAN_96)).not.toContain("guía 7→8");
    expect(planAsksPreview(PLAN_96)).toBe(true);
  });
  it("una preview que sólo aparece en Pasos o Riesgos no la exige", () => {
    expect(planAsksPreview("## Criterios de aceptación\n- El CLI imprime la versión.\n## Pasos\n1. Mirar la preview.")).toBe(false);
  });
  it("criterios al final del plan y «vista previa»", () => {
    expect(planAsksPreview("# X\n## Criterios\n- Se ve en la vista previa.")).toBe(true);
    expect(planAsksPreview(null)).toBe(false);
  });
});

describe("previewRequiredFrom", () => {
  const base = { repoOff: false, requiresPreview: null, planMd: null, dependabotLevel: null } as const;
  it("el #96: un major de Dependabot la exige aunque el plan no lo marque", () => {
    expect(previewRequiredFrom({ ...base, dependabotLevel: "major" })).toBe(true);
    expect(previewRequiredFrom({ ...base, dependabotLevel: "unknown" })).toBe(true);
    expect(previewRequiredFrom({ ...base, dependabotLevel: "patch" })).toBe(false);
  });
  it("la marca del plan manda sobre el texto", () => {
    expect(previewRequiredFrom({ ...base, requiresPreview: true })).toBe(true);
    expect(previewRequiredFrom({ ...base, requiresPreview: false, planMd: PLAN_96 })).toBe(false);
    expect(previewRequiredFrom({ ...base, planMd: PLAN_96 })).toBe(true);
  });
  it("con la preview del repo apagada, nunca", () => {
    expect(previewRequiredFrom({ ...base, repoOff: true, requiresPreview: true, dependabotLevel: "major" })).toBe(false);
  });
});

describe("previewGateBlock", () => {
  it("lista en la cabeza: pasa", () => {
    expect(previewGateBlock({ state: "ready", sha: "abc" }, "abc")).toBeNull();
  });
  it("lista pero de un commit viejo: espera", () => {
    expect(previewGateBlock({ state: "ready", sha: "old" }, "abc")).toEqual({ reason: "se está construyendo", waits: true });
  });
  it("sin variables o fallida: bloquea y no se espera sola", () => {
    expect(previewGateBlock({ state: "needs_env", sha: null }, "abc")).toEqual({ reason: "espera las variables del repo", waits: false });
    expect(previewGateBlock({ state: "failed", sha: null, error: "Mongo no arrancó" }, "abc")?.reason).toBe("falló: Mongo no arrancó");
    expect(previewGateBlock({ state: "none", sha: null }, "abc")?.waits).toBe(false);
  });
});

describe("previewViabilityLine: variables de producción (#96)", () => {
  const base = { off: false, hosting: false, runnable: true, envExampleKeys: ["DATABASE_URL"], envSavedKeys: ["DATABASE_URL", "STRIPE_SECRET_KEY"] };
  it("avisa con nombre y motivo, y lo que no se hace mientras", () => {
    const line = previewViabilityLine("o/agenda", {
      ...base,
      envRisks: [{ key: "DATABASE_URL", risk: "remote_db" }, { key: "STRIPE_SECRET_KEY", risk: "live_payment_key" }],
    });
    expect(line).toContain("la caja de gs la levanta");
    expect(line).toContain("⚠ La preview de o/agenda usa recursos de PRODUCCIÓN: DATABASE_URL (base remota), STRIPE_SECRET_KEY (llave live)");
    expect(line).toContain("Lo que escriba, cobre o envíe será real");
    expect(line).toContain("nada de pruebas que escriban");
    expect(line).toContain("no se completan pagos");
  });
  it("sin riesgos, o con la preview del hosting o apagada, no avisa", () => {
    expect(previewViabilityLine("o/r", { ...base, envRisks: [] })).not.toContain("PRODUCCIÓN");
    expect(previewViabilityLine("o/r", { ...base })).not.toContain("PRODUCCIÓN");
    const risks = [{ key: "DATABASE_URL", risk: "remote_db" as const }];
    expect(previewViabilityLine("o/r", { ...base, hosting: true, envRisks: risks })).not.toContain("PRODUCCIÓN");
    expect(previewViabilityLine("o/r", { ...base, off: true, envRisks: risks })).not.toContain("PRODUCCIÓN");
  });
  it("envRiskLine con sólo correo no promete reglas de base ni pagos", () => {
    const line = envRiskLine("o/r", [{ key: "SES_KEY", risk: "real_email" }])!;
    expect(line).toContain("SES_KEY (correo real)");
    expect(line).not.toContain("mientras");
    expect(envRiskLine("o/r", null)).toBeNull();
  });
});
