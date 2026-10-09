// Uso Limitado en Teams: un dato de Google sólo entra si TODOS los modelos que leen el destino son
// Anthropic u OpenAI (lo dice Studio por agente). Falla cerrado y nunca en silencio.
import { beforeEach, describe, expect, it, vi } from "vitest";

let pools: { id: string; limitedUse?: boolean }[] | Error = [];
let agentes: unknown[] = [];

vi.mock("./tenant.server", () => ({ currentNamespace: async () => "ns-1" }));
vi.mock("./ghosty-runtime.server", () => ({ nativeRuntimeBase: async () => "https://gs.test" }));
vi.mock("./fleet-native.server", () => ({
  listNativeFleetAgents: async () => {
    if (pools instanceof Error) throw pools;
    return pools;
  },
}));
vi.mock("../agents.server", () => ({ resolvedAgents: async () => agentes }));

import { agentsBlockingGoogle, destLimitedUse, forgetLimitedUse, GOOGLE_REDACTED, redactGoogle } from "./limited-use.server";

const fleet = (handle: string, id: string) => ({ handle, name: handle, backend: { kind: "fleet", id, token: "" } }) as never;
const acpAMano = { handle: "taller", name: "taller", backend: { kind: "acp", id: "", runtime: "acp", runtimeUrl: "wss://x", scope: new Set() } } as never;
const claude = fleet("ghosty", "fa-claude");
const deepseek = fleet("lite", "fa-lite");

beforeEach(() => {
  forgetLimitedUse();
  pools = [{ id: "fa-claude", limitedUse: true }, { id: "fa-lite", limitedUse: false }];
});

describe("¿todos los lectores del destino son de Uso Limitado?", () => {
  it("sala con sólo agentes Claude/OpenAI: sí", async () => {
    agentes = [claude];
    expect(await destLimitedUse({ channelId: 3 }, claude)).toBe(true);
  });
  it("sala donde también está un agente DeepSeek: no, aunque el turno sea de Claude", async () => {
    agentes = [claude, deepseek];
    expect(await destLimitedUse({ channelId: 3 }, claude)).toBe(false);
    expect(await agentsBlockingGoogle()).toEqual([{ handle: "lite", name: "lite" }]);
  });
  it("DM: sólo cuenta su agente", async () => {
    agentes = [claude, deepseek];
    expect(await destLimitedUse({ dmId: 7 }, claude)).toBe(true);
    expect(await destLimitedUse({ dmId: 7 }, deepseek)).toBe(false);
  });
  it("lo que Studio no conoce (ACP pegado a mano, A2A, webhook) cuenta como no", async () => {
    agentes = [claude, acpAMano];
    expect(await destLimitedUse({ dmId: 7 }, acpAMano)).toBe(false);
    expect(await destLimitedUse({ channelId: 3 }, claude)).toBe(false);
  });
  it("Studio viejo sin el campo, o caído: no (falla cerrado)", async () => {
    agentes = [claude];
    pools = [{ id: "fa-claude" }];
    expect(await destLimitedUse({ dmId: 7 }, claude)).toBe(false);
    forgetLimitedUse();
    pools = new Error("503");
    expect(await destLimitedUse({ dmId: 7 }, claude)).toBe(false);
    expect(await agentsBlockingGoogle()).toBeNull();
  });
  it("turno de la fábrica con un modelo que no es Claude/OpenAI: no", async () => {
    agentes = [claude];
    expect(await destLimitedUse({ dmId: 7 }, claude, { fleetId: "fa-claude", model: "deepseek-v4-pro" })).toBe(false);
    expect(await destLimitedUse({ dmId: 7 }, claude, { fleetId: "fa-claude", model: "claude-opus-5-5" })).toBe(true);
  });
});

describe("lo etiquetado se redacta, no desaparece", () => {
  const msgs = [{ id: 1, body: "tu hoja dice $12,400", google_data: 1 }, { id: 2, body: "gracias", google_data: 0 }];
  it("destino sin Uso Limitado: el mensaje sigue, con el motivo en lugar del texto", () => {
    expect(redactGoogle(msgs, false).map((m) => m.body)).toEqual([GOOGLE_REDACTED, "gracias"]);
  });
  it("destino de Uso Limitado: intacto", () => {
    expect(redactGoogle(msgs, true)).toBe(msgs);
  });
});
