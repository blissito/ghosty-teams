// El transporte del servidor MCP. Lo que se prueba es el MÍNIMO CONFORME de Streamable HTTP,
// que es donde un servidor escrito a mano se equivoca:
//  · una notificación se contesta con 202 SIN CUERPO, no con un JSON-RPC;
//  · el GET devuelve 405 (la spec permite eso en vez de ofrecer SSE);
//  · una versión desconocida NO es un error: se responde la propia y decide el cliente.
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../server/tenant.server", () => ({ currentNamespace: async () => "acme" }));
const autoridad = vi.fn();
vi.mock("../server/turns.server", () => ({ inflightAuthority: (...a: unknown[]) => autoridad(...a) }));
const listUserTools = vi.fn();
const runTool = vi.fn();
vi.mock("../server/connectors/tools.server", () => ({
  listUserTools: (...a: unknown[]) => listUserTools(...a),
  runTool: (...a: unknown[]) => runTool(...a),
}));

beforeAll(() => {
  process.env.GHOSTY_PARTNER_SECRET = "secreto-de-prueba";
});
const { Route } = await import("./api.mcp");
const { mintMcpTicket } = await import("../server/mcp-ticket.server");

const h = (Route.options as any).server.handlers;
const TICKET = () => mintMcpTicket({ ns: "acme", agent: "gemini", groupId: "g1" });

const post = (body: unknown, extra: Record<string, string> = {}) =>
  h.POST({
    request: new Request("https://acme.teams.ghosty.studio/api/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TICKET()}`, ...extra },
      body: JSON.stringify(body),
    }),
  });

describe("transporte", () => {
  it("el GET dice 405: aquí no hay stream", async () => {
    expect((await h.GET()).status).toBe(405);
    expect((await h.DELETE()).status).toBe(405);
  });

  it("una notificación se contesta 202 y SIN cuerpo", async () => {
    const r = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(r.status).toBe(202);
    expect(await r.text()).toBe("");
  });

  it("initialize hace eco de la versión que pide el cliente", async () => {
    const r = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
    const j = await r.json();
    expect(j.result.protocolVersion).toBe("2025-03-26");
    // Sólo `tools`: omitir `resources` y `prompts` ES la forma de decir que no hay.
    expect(Object.keys(j.result.capabilities)).toEqual(["tools"]);
  });

  it("una versión desconocida NO es un error: se ofrece la nuestra", async () => {
    const r = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    const j = await r.json();
    expect(j.error).toBeUndefined();
    expect(j.result.protocolVersion).toBe("2025-06-18");
  });

  it("un método que no conocemos: -32601", async () => {
    const j = await (await post({ jsonrpc: "2.0", id: 2, method: "resources/list" })).json();
    expect(j.error.code).toBe(-32601);
  });

  // El único MUST de seguridad del transporte. Un agente en su caja no manda Origin; el que
  // lo manda es un navegador, y una página cualquiera no puede usar las tools de quien la abra.
  it("con Origin, se rechaza", async () => {
    const r = await post({ jsonrpc: "2.0", id: 1, method: "initialize" }, { Origin: "https://evil.example" });
    expect(r.status).toBe(403);
  });

  it("sin ticket válido no se contesta nada útil", async () => {
    const r = await h.POST({
      request: new Request("https://acme.teams.ghosty.studio/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer basura" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      }),
    });
    expect((await r.json()).error.code).toBe(-32001);
  });
});

describe("autoridad", () => {
  it("sin turno en vuelo, la lista viene VACÍA y no como error", async () => {
    autoridad.mockReturnValue(null);
    const j = await (await post({ jsonrpc: "2.0", id: 3, method: "tools/list" })).json();
    expect(j.result.tools).toEqual([]);
    expect(listUserTools).not.toHaveBeenCalled();
  });

  it("sin turno en vuelo, ejecutar es un error", async () => {
    autoridad.mockReturnValue(null);
    const j = await (await post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "chat_message" } })).json();
    expect(j.error.code).toBe(-32002);
    expect(runTool).not.toHaveBeenCalled();
  });

  // La regla más dura del sistema: el texto del turno lo escribe un extraño.
  it("en canal público no hay herramientas", async () => {
    autoridad.mockReturnValue({ invokerSub: "s-ana", dest: {}, scope: new Set(), publicChannel: true });
    const j = await (await post({ jsonrpc: "2.0", id: 5, method: "tools/list" })).json();
    expect(j.result.tools).toEqual([]);
  });

  it("se ejerce a nombre del INVOCADOR del turno, no del dueño del agente", async () => {
    autoridad.mockReturnValue({ invokerSub: "s-ana", dest: { channelId: 4 }, scope: new Set(["lectura"]), publicChannel: false });
    runTool.mockResolvedValue({ ok: true, texto: "listo" });
    await post({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "chat_history", arguments: { limit: 5 } } });
    expect(runTool).toHaveBeenCalledWith("s-ana", "chat_history", { limit: 5 }, { channelId: 4 }, expect.any(Set));
  });

  // Un fallo de la tool es CONTENIDO con `isError`, no un error de JSON-RPC: si no, el
  // agente lo lee como "el servidor se rompió" y reintenta.
  it("una tool que falla va como contenido con isError", async () => {
    autoridad.mockReturnValue({ invokerSub: "s-ana", dest: {}, scope: new Set(), publicChannel: false });
    runTool.mockResolvedValue({ ok: false, error: "no se pudo" });
    const j = await (await post({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "x" } })).json();
    expect(j.error).toBeUndefined();
    expect(j.result.isError).toBe(true);
    expect(j.result.content[0].text).toContain("no se pudo");
  });
});
