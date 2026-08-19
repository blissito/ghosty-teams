// Que un alcance ACOTADO siga viendo las tools de sus conectores.
//
// Aquí vivía el bug que dejó a @goose sin nada el 19 ago 2026: `listUserTools` tenía un atajo
// que, con cualquier scope distinto de `completo`, devolvía sólo las nativas y NI CONSULTABA
// los conectores. O sea que dar permiso de `codigo` no servía de nada, y desde fuera parecía
// que el permiso estaba roto — el agente acabó intentando `gh` por shell.
//
// Molde: room-repos.test.ts.
import { describe, expect, it, vi } from "vitest";

vi.mock("./store.server", () => ({
  listAvailableProviders: async () => ["github"],
  resolveConnectorOwner: async () => null,
}));
vi.mock("./native.server", () => ({
  nativeTools: () => [
    { name: "chat_history", description: "", inputSchema: {}, handler: async () => ({}) },
    { name: "email_send", description: "", inputSchema: {}, handler: async () => ({}) },
  ],
}));
vi.mock("./tasks.native.server", () => ({ taskTools: async () => [] }));
// El conector de GitHub, reducido a lo que importa: que sus tools existan para listarse.
vi.mock("./impl", () => ({
  loaderFor: (id: string) => (id === "github" ? async () => ({}) : null),
  toolsOf: async () => [
    { name: "github_create_issue", description: "", inputSchema: {} },
    { name: "github_checkout", description: "", inputSchema: {} },
  ],
}));

const { listUserTools } = await import("./tools.server");
const { parseScope } = await import("./tool-token.server");

const nombres = async (scope: string) => (await listUserTools("ana", { channelId: 7 }, parseScope(scope))).map((t) => t.name);

describe("el listado con alcance acotado", () => {
  it("🔴 con `codigo` SÍ se consultan los conectores y salen sus tools", async () => {
    expect(await nombres("lectura,codigo")).toEqual(["chat_history", "github_create_issue", "github_checkout"]);
  });

  it("con `lectura` no se anuncia nada de GitHub ni de correo", async () => {
    expect(await nombres("lectura")).toEqual(["chat_history"]);
  });

  it("con `completo` sale todo, como para los agentes nativos", async () => {
    expect(await nombres("completo")).toEqual([
      "chat_history",
      "email_send",
      "github_create_issue",
      "github_checkout",
    ]);
  });
});
