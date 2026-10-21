import { describe, it, expect, vi } from "vitest";

// ¿Alguien trabaja en el pedido? Un turno zombi o un despertador lejano tapaban un pedido colgado
// para siempre (business #136, 21-oct).
vi.mock("../dbq.server", () => ({ dbq: async () => [] }));
vi.mock("./tenant.server", () => ({ withNamespace: async (_ns: string, f: () => unknown) => f() }));

import { staleRunBusy, LIVE_TURN_IDLE_MS } from "./wakeups.server";

const run = { id: 136, channelId: 10, rootMsgId: 7242 };
const turn = (o: Partial<{ messageId: number; channelId: number; parentId: number; idleMs: number; stopped: boolean }> = {}) => ({
  messageId: 7426, channelId: 10, parentId: 7242, idleMs: 60_000, stopped: false, ...o,
});

describe("staleRunBusy", () => {
  it("turno vivo con señal de vida reciente: ocupado", () => {
    expect(staleRunBusy(run, [turn()], [])).toEqual({ busy: true, zombies: [] });
  });

  it("turno en el mapa pero mudo hace horas: no cuenta y sale como zombi", () => {
    expect(staleRunBusy(run, [turn({ idleMs: LIVE_TURN_IDLE_MS + 1 })], [])).toEqual({ busy: false, zombies: [7426] });
  });

  it("turno de otro hilo: no cuenta", () => {
    expect(staleRunBusy(run, [turn({ parentId: 1 })], []).busy).toBe(false);
  });

  it("relevo del pedido por salir: ocupado (y el zombi no se toca)", () => {
    expect(staleRunBusy(run, [turn({ idleMs: LIVE_TURN_IDLE_MS + 1 })], [{ key: "factory:136:check:1:retry" }])).toEqual({ busy: true, zombies: [] });
    expect(staleRunBusy(run, [], [{ key: "handoff:10:7242:check" }]).busy).toBe(true);
  });

  it("relevo de otro pedido: no cuenta", () => {
    expect(staleRunBusy(run, [], [{ key: "factory:1360:check:1" }]).busy).toBe(false);
  });
});
