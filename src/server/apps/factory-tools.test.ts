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

import { factoryTools, factoryContext } from "./factory-tools.server";
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

  it("las familias acotan: sólo `fabrica` o `completo` las alcanzan", () => {
    expect(toolEnScope("alert_webhook_create", new Set(["fabrica"]) as any)).toBe(true);
    expect(toolEnScope("factory_plan_submit", new Set(["fabrica"]) as any)).toBe(true);
    expect(toolEnScope("alert_webhook_create", new Set(["codigo"]) as any)).toBe(false);
    expect(toolEnScope("factory_plan_submit", new Set(["completo"]) as any)).toBe(true);
  });
});
