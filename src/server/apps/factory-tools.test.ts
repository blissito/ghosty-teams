import { describe, it, expect, vi, beforeEach } from "vitest";

// Lo que pidió bliss: las tools de la fábrica existen SÓLO en un espacio que la instaló.
let installed = false;
vi.mock("./installed.server", () => ({ isInstalled: async () => installed }));
vi.mock("../hooks/generic-alert.server", () => ({
  alertWebhookTools: () => [
    { name: "alert_webhook_create", description: "", inputSchema: {}, handler: async () => ({ ok: true }) },
    { name: "alert_webhook_list", description: "", inputSchema: {}, handler: async () => ({ ok: true }) },
  ],
}));

import { factoryTools, factoryContext, planRejection, planTitle } from "./factory-tools.server";
import { toolEnScope } from "../connectors/tools.server";

describe("factoryTools", () => {
  beforeEach(() => {
    installed = false;
  });

  it("sin la app instalada no hay tools ni contexto", async () => {
    expect(await factoryTools("u", { channelId: 1 })).toEqual([]);
    expect(await factoryContext({ channelId: 1 })).toBeNull();
  });

  it("con la app instalada aparecen las de alertas y su contexto", async () => {
    installed = true;
    const names = (await factoryTools("u", { channelId: 1 })).map((t) => t.name);
    expect(names).toContain("alert_webhook_create");
    expect(await factoryContext({ channelId: 1 })).toContain("SOFTWARE FACTORY");
  });

  it("el contexto trae las instrucciones del ROL con que te invocaron", async () => {
    installed = true;
    const check = (await factoryContext({ channelId: 1, handle: "check" }))!;
    expect(check).toContain("Eres @check");
    expect(check).not.toContain("Eres @build");
    const otro = (await factoryContext({ channelId: 1, handle: "ghosty" }))!;
    expect(otro).not.toContain("Eres @");
  });

  it("las familias acotan: sólo `fabrica` o `completo` las alcanzan", () => {
    expect(toolEnScope("alert_webhook_create", new Set(["fabrica"]) as any)).toBe(true);
    expect(toolEnScope("factory_plan_submit", new Set(["fabrica"]) as any)).toBe(true);
    expect(toolEnScope("alert_webhook_create", new Set(["codigo"]) as any)).toBe(false);
    expect(toolEnScope("factory_plan_submit", new Set(["completo"]) as any)).toBe(true);
  });
});

// 2026-09-24: @plan (deepseek-v4-flash) probó la tool con relleno y quedó como v1 y v2.
describe("planRejection", () => {
  it("rechaza el relleno que llegó a producción", () => {
    expect(planRejection("Markdown Markdown Markdown Markdown Markdown Markdown")).not.toBeNull();
    expect(planRejection("SONDEO DE CAMPO (reemplazar por el plan real). " + "relleno ".repeat(70))).not.toBeNull();
  });
  it("acepta un plan de verdad", () => {
    const plan = `# Plan — Homologación de actions
## Historia
Que el catálogo de actions del agente de backoffice no se quede atrás cuando se construye o modifica un feature del API.
## Criterios de aceptación
- Un test de paridad falla si una ruta nueva no tiene action registrada.
- El registro se genera desde services y no se duplica a mano.
## Riesgos
Rutas internas que no deben exponerse al agente; se listan en una allowlist explícita.`;
    expect(planRejection(plan)).toBeNull();
  });
});

describe("planTitle", () => {
  it("usa el título explícito, si no el primer encabezado", () => {
    expect(planTitle("Paridad de actions", "# Otro")).toBe("Paridad de actions");
    expect(planTitle(undefined, "intro\n# Plan v3 — Homologación\n...")).toBe("Plan v3 — Homologación");
    expect(planTitle("", "Sin encabezado\nresto")).toBe("Sin encabezado");
  });
});

describe("título del pedido", () => {
  it("salta los encabezados de sección del plan", async () => {
    const { planTitle } = await import("./factory-tools.server");
    expect(planTitle(undefined, "## Historia\nqueremos x\n## Brief técnico\n...")).toBe("queremos x");
    expect(planTitle(undefined, "# Limpiar la raíz\n## Historia\n...")).toBe("Limpiar la raíz");
    expect(planTitle("Explícito", "## Historia")).toBe("Explícito");
    expect(planTitle(undefined, "## Riesgos y qué NO se hará\n# Limpiar la raíz")).toBe("Limpiar la raíz");
    // Un título real que EMPIEZA como una sección no es una sección.
    expect(planTitle(undefined, "# Pruebas vitest para agendaUtils\n...")).toBe("Pruebas vitest para agendaUtils");
  });
});

describe("pedidos sugeridos con varios repos", () => {
  it("cada uno dice su repo; con uno solo se asume", async () => {
    const { suggestItems } = await import("./factory-tools.server");
    const it1 = { size: "chico", title: "Pruebas", ask: "agrega pruebas de vitest para las funciones puras de utils.ts", why: "sin pruebas" };
    const two = [it1, { ...it1, title: "Otra" }];
    expect(suggestItems(two, ["acme/web", "acme/api"])).toMatch(/de cuál repo/);
    const ok = suggestItems(two.map((x) => ({ ...x, repo: "acme/api" })), ["acme/web", "acme/api"]);
    expect(Array.isArray(ok) && ok[0].repo).toBe("acme/api");
    const single = suggestItems(two, ["acme/web"]);
    expect(Array.isArray(single) && single[1].repo).toBe("acme/web");
  });
});
