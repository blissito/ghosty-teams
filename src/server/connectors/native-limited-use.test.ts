// Las tools nativas respetan la etiqueta de Google: lo marcado llega redactado a un destino sin Uso
// Limitado, y desde una conversación con datos de Google no se escribe memoria que lean otros modelos.
import { describe, expect, it, vi } from "vitest";

const writes: string[] = [];
vi.mock("../../db.server", () => ({
  searchInScope: async () => [{ id: 1, body: "la hoja dice $12,400", google_data: 1, agent_handle: "ghosty", sender: "Ghosty", created_at: 1 }],
  attachAttachments: async (m: unknown) => m,
  googleConversationAt: async (k: string) => (k === "dm:7" || k === "ch:3:0" ? 123 : null),
  memoryScopeKey: () => "dm-7",
  addAgentMemory: async () => (writes.push("add"), 5),
  setMemoryGoogleData: async () => void writes.push("label"),
  listAgentMemory: async () => [],
  MEMORY_MAX_CHARS: 240,
  MEMORY_MAX_NOTES: 40,
}));
vi.mock("../limited-use.server", async (orig) => ({ ...(await orig<any>()), agentsBlockingGoogle: async () => [{ handle: "lite", name: "lite" }] }));

import { nativeTools } from "./native.server";
import { GOOGLE_REDACTED } from "../limited-use.server";

const tool = (dest: object, lu: boolean, name: string) => nativeTools(dest as never, lu).find((t) => t.name === name)!;

describe("etiqueta de Google en las tools nativas", () => {
  it("chat_search sin Uso Limitado: el mensaje aparece, redactado", async () => {
    const r = (await tool({ channelId: 3 }, false, "chat_search").handler("ana", { query: "hoja" })) as { messages: { body?: string; text?: string }[] };
    expect(JSON.stringify(r.messages)).toContain(GOOGLE_REDACTED);
    expect(JSON.stringify(r.messages)).not.toContain("12,400");
  });
  it("memory_write en una sala con datos de Google y un agente DeepSeek en el espacio: no, con motivo", async () => {
    const r = (await tool({ channelId: 3, handle: "ghosty" }, false, "memory_write").handler("ana", { note: "Ana paga $12,400", scope: "room_rules" })) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Uso Limitado/);
  });
  it("memory_write en un DM de Uso Limitado: se guarda y queda etiquetada", async () => {
    writes.length = 0;
    const r = (await tool({ dmId: 7, handle: "ghosty" }, true, "memory_write").handler("ana", { note: "Ana paga $12,400" })) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(writes).toEqual(["add", "label"]);
  });
  it("doc_read en una conversación con datos de Google sin Uso Limitado: motivo, no documento", async () => {
    const r = (await tool({ dmId: 7 }, false, "doc_read").handler("ana", {})) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Uso Limitado/);
  });
});
