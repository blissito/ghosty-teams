// `room: true` saca la búsqueda del hilo al room entero, pero nunca a otra conversación: el
// room es el del destino firmado (un rol de la fábrica busca lo que se dijo en otro hilo).
import { describe, expect, it, vi } from "vitest";

const scopes: unknown[] = [];
vi.mock("../../db.server", () => ({
  searchInScope: async (scope: unknown) => (scopes.push(scope), []),
  messagesByIdInScope: async (scope: unknown) => (scopes.push(scope), []),
  attachAttachments: async (m: unknown) => m,
}));

import { nativeTools } from "./native.server";

const tool = (name: string) => nativeTools({ channelId: 14, parentId: 4140 }).find((t) => t.name === name)!;

describe("chat_search / chat_message con room", () => {
  it("sin room se queda en el hilo", async () => {
    scopes.length = 0;
    await tool("chat_search").handler("ana", { query: "preset" });
    expect(scopes[0]).toEqual({ channelId: 14, parentId: 4140 });
  });
  it("con room:true busca en todo el room", async () => {
    scopes.length = 0;
    await tool("chat_search").handler("ana", { query: "preset", room: true });
    await tool("chat_message").handler("ana", { ids: [5], room: true });
    expect(scopes).toEqual([{ channelId: 14 }, { channelId: 14 }]);
  });
});
