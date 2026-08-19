// Que lo de hoy no le haya cambiado nada a los agentes que NO son ACP.
//
// Todo el trabajo del 19 ago 2026 tocó archivos COMPARTIDOS —el dispatch de tools, el contexto
// de conectores, el parser de fences— y los agentes nativos, A2A y webhook pasan por ahí todos
// los días. Estas pruebas fijan el contrato de "para ellos, nada cambió"; si algún día alguien
// necesita romperlo, que lo rompa a propósito y con este archivo en rojo.
import { describe, expect, it, vi } from "vitest";

vi.mock("./store.server", () => ({
  listAvailableProviders: async () => ["github", "sentry"],
  resolveConnectorOwner: async () => null,
}));
vi.mock("./native.server", () => ({
  nativeTools: () => [
    { name: "chat_history", description: "", inputSchema: {}, handler: async () => ({}) },
    { name: "email_send", description: "", inputSchema: {}, handler: async () => ({}) },
    { name: "reminder_create", description: "", inputSchema: {}, handler: async () => ({}) },
  ],
}));
vi.mock("./tasks.native.server", () => ({ taskTools: async () => [] }));
vi.mock("./impl", () => ({
  // Sólo GitHub tiene loader: si se lo diéramos a los dos proveedores, sus tools se contarían
  // dos veces y el test mediría el mock en vez del código.
  loaderFor: (id: string) => (id === "github" ? async () => ({}) : null),
  toolsOf: async () => [{ name: "github_create_issue", description: "", inputSchema: {} }],
}));

const { listUserTools, runTool, toolEnScope } = await import("./tools.server");
const { SCOPE_COMPLETO } = await import("./tool-token.server");

describe("un agente nativo (sin scope) sigue viéndolo todo", () => {
  it("el listado no pierde ni una tool por el filtro nuevo", async () => {
    // Los call-sites nativos no pasan `scope`: cae al default y el filtro tiene que ser
    // transparente. Si esto se rompe, un agente de siempre se queda sin herramientas.
    const sinArg = (await listUserTools("ana", { channelId: 7 })).map((t) => t.name);
    expect(sinArg).toContain("email_send");
    expect(sinArg).toContain("github_create_issue");
    expect(sinArg).toContain("reminder_create");
    // Y explícito con `completo` da exactamente lo mismo.
    expect((await listUserTools("ana", { channelId: 7 }, SCOPE_COMPLETO)).map((t) => t.name)).toEqual(sinArg);
  });

  it("ninguna tool queda fuera de alcance por defecto", () => {
    for (const t of ["email_send", "github_merge_pr", "sentry_list_issues", "lo_que_sea_nuevo"]) {
      expect(toolEnScope(t, SCOPE_COMPLETO)).toBe(true);
    }
  });

  it("una tool que no existe sigue fallando por 'no conectado', no por alcance", async () => {
    // El mensaje importa: si el alcance empezara a comerse este caso, un conector caído se
    // diagnosticaría como un permiso mal puesto.
    const r = await runTool("ana", "conector_inexistente_tool", {}, { channelId: 7 });
    expect((r as { error: string }).error).not.toContain("alcance");
  });
});

describe("en un hilo, todo igual que en el canal", () => {
  const HILO = { channelId: 7, parentId: 2214 };

  it("el listado de tools no cambia por estar dentro de un hilo", async () => {
    const canal = (await listUserTools("ana", { channelId: 7 })).map((t) => t.name);
    expect((await listUserTools("ana", HILO)).map((t) => t.name)).toEqual(canal);
  });

  it("y un agente ACP acotado ve lo mismo en el hilo que en el canal", async () => {
    const { parseScope } = await import("./tool-token.server");
    const acotado = parseScope("lectura,codigo");
    const canal = (await listUserTools("ana", { channelId: 7 }, acotado)).map((t) => t.name);
    expect((await listUserTools("ana", HILO, acotado)).map((t) => t.name)).toEqual(canal);
    expect(canal).toEqual(["chat_history", "github_create_issue"]);
  });
});
