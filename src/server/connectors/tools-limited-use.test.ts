// Drive de Studio en Teams: sin el permiso firmado del destino (`lu`) ni se le pregunta a Studio,
// y el agente recibe el motivo; con él, el puente lo manda firmado y la conversación queda marcada.
import { describe, expect, it, vi } from "vitest";

const calls: Record<string, unknown>[] = [];
const marks: string[] = [];
vi.mock("./studio-bridge.server", async (orig) => ({
  ...(await orig<any>()),
  runStudioTool: async (_sub: string, name: string, args: unknown, readOnly: boolean, limitedUse: boolean) => (
    calls.push({ action: "run", name, args, readOnly, limitedUse }), { ok: true, result: { archivos: [] } }
  ),
}));
vi.mock("../../db.server", () => ({ markGoogleConversation: async (k: string) => void marks.push(k) }));

import { runTool } from "./tools.server";
import { LIMITED_USE_SHARED_DENIED } from "../limited-use.server";

describe("drive_* desde Teams", () => {
  it("sin `lu`: motivo claro y Studio ni se entera", async () => {
    const r = await runTool("ana", "drive_archivos", {}, { channelId: 3 }, undefined, false);
    expect(r).toEqual({ ok: false, error: LIMITED_USE_SHARED_DENIED });
    expect(calls).toHaveLength(0);
  });
  it("con `lu`: va firmado a Studio y la conversación queda marcada", async () => {
    const r = await runTool("ana", "drive_archivos", {}, { channelId: 3, parentId: 9 }, undefined, true);
    expect(r.ok).toBe(true);
    expect(calls[0]).toMatchObject({ action: "run", name: "drive_archivos", limitedUse: true });
    expect(marks).toEqual(["ch:3:9"]);
  });
});
