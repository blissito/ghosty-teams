// El bloque de contexto de GitHub, según QUIÉN lo va a leer.
//
// El mismo texto sirve para dos clases de agente que invocan las tools de forma distinta: un
// worker nativo por el SDK de su caja, y un agente ACP como herramientas del protocolo.
// Darle a un ACP la instrucción del SDK es peor que no darle ninguna: intenta importar un
// archivo que no existe en su caja y concluye que no tiene la integración.
import { describe, expect, it, vi } from "vitest";

vi.mock("./store.server", () => ({
  getConnectorRow: async () => ({
    user_sub: "ana",
    access_token: "tok",
    meta: JSON.stringify({ login: "blissito" }),
  }),
}));
vi.mock("./oauth.server", () => ({ getValidToken: async () => "tok" }));
vi.mock("../../db.server", () => ({
  listRoomRepos: async () => [{ repo: "blissito/easybits", connectedBy: "ana", createdAt: 0 }],
}));

const { ambientContext } = await import("./github.server");

const bloque = async (canal?: "gs-sdk" | "mcp") =>
  (await ambientContext("ana", "Bliss", "abre un issue", { channelId: 7 }, canal ? { toolChannel: canal } : undefined)) ?? "";

describe("el hint de GitHub", () => {
  it("a un agente ACP no le habla de un SDK que no tiene", async () => {
    const b = await bloque("mcp");
    expect(b).not.toContain("/opt/gs-sdk");
    expect(b).not.toContain("connectors.mjs");
    expect(b).toMatch(/las llamas por su nombre/i);
    // Y sí le dice lo que importa: sobre qué repo trabaja.
    expect(b).toContain("blissito/easybits");
  });

  it("al worker nativo se le sigue diciendo lo de siempre", async () => {
    // Por defecto, sin `toolChannel`: ningún call-site existente cambia de comportamiento.
    expect(await bloque()).toContain("/opt/gs-sdk/connectors.mjs");
    expect(await bloque("gs-sdk")).toContain("/opt/gs-sdk/connectors.mjs");
  });

  it("🔴 prohíbe `gh` Y prohíbe el sustituto", async () => {
    // Cerrar sólo la vía del `gh` no basta: el 19 ago un agente no lo encontró y, en vez de
    // decirlo, REDACTÓ el issue en un artefacto y lo entregó como si fuera lo pedido.
    const b = await bloque("mcp");
    expect(b).toMatch(/no hay `gh`/i);
    expect(b).toMatch(/no redactes en un documento lo que te pidieron crear/i);
  });
});
