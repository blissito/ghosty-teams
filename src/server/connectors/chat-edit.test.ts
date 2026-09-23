import { describe, expect, it } from "vitest";
import { isOwnAgentMessage } from "./native.server";

// `chat_edit` sólo puede tocar mensajes del propio agente. En un DM TODOS los mensajes llevan
// el handle del agente, y un humano que lo etiqueta también: lo que decide es `sender_sub`.
describe("isOwnAgentMessage", () => {
  it("mensaje del agente → sí", () => {
    expect(isOwnAgentMessage({ sender_sub: null, agent_handle: "lens", mentions_ghosty: 0 }, "lens")).toBe(true);
  });
  it("humano en un DM con el agente → no", () => {
    expect(isOwnAgentMessage({ sender_sub: "u_ana", agent_handle: "lens", mentions_ghosty: 0 }, "lens")).toBe(false);
  });
  it("mención de un humano (sin sub en filas viejas) → no", () => {
    expect(isOwnAgentMessage({ sender_sub: null, agent_handle: "lens", mentions_ghosty: 1 }, "lens")).toBe(false);
  });
  it("mensaje de OTRO agente → no", () => {
    expect(isOwnAgentMessage({ sender_sub: null, agent_handle: "otro", mentions_ghosty: 0 }, "lens")).toBe(false);
  });
});
