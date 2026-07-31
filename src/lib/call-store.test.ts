// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";

// Regla que este archivo fija: SALIRSE ES DEFINITIVO. La marca de sesión que permite
// re-unirse tras un F5 se escribe sólo al unirse y se borra en el mismo acto de salir, así
// que colgar y recargar NUNCA te vuelve a meter — ni aunque la llamada siga viva con otra
// gente. Es la trampa obvia de la feature "re-unirse solo" y el usuario la pidió explícita.

const MARK = "gt:call:rejoin";

// ── Dobles ───────────────────────────────────────────────────────────────────
class FakeRoom {
  localParticipant = { setMicrophoneEnabled: vi.fn(async () => {}) };
  remoteParticipants = new Map();
  connect = vi.fn(async () => {});
  disconnect = vi.fn(() => {});
  removeAllListeners = vi.fn(() => {});
  on() {
    return this;
  }
}
vi.mock("livekit-client", () => ({
  Room: FakeRoom,
  RoomEvent: new Proxy({}, { get: (_t, k) => String(k) }),
}));

const conn = { token: "t", wss: "wss://x", room: "qc_1", name: "yo" };
const getActiveCallFn = vi.fn(async () => ({ callId: "c1", host: { sub: "otro", name: "Otro", avatar: "" }, label: "General", startedAt: 0, participants: 2 }));
const joinCallFn = vi.fn(async () => conn);
const startCallFn = vi.fn(async () => ({ callId: "c1", ...conn }));
const leaveCallFn = vi.fn(async () => ({ ok: true as const, ended: false }));
vi.mock("../server/quick-calls", () => ({ getActiveCallFn, joinCallFn, startCallFn, leaveCallFn }));
vi.mock("../server/stars", () => ({ listMutesFn: vi.fn(async () => []) }));
vi.mock("../utils/notificationSound", () => ({
  playNotificationSound: vi.fn(),
  startCallRing: vi.fn(),
  stopCallRing: vi.fn(),
}));
vi.mock("../utils/system-notification", () => ({ showSystemNotification: vi.fn() }));

const target = { scope: "room" as const, slug: "general" };
const load = async () => {
  vi.resetModules(); // módulo fresco = pestaña recién cargada
  return await import("./call-store");
};

describe("marca de re-unirse tras recargar", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  it("unirse deja marca; recargar re-une si la llamada sigue viva", async () => {
    const s1 = await load();
    await s1.openCall(joinCallFn, "room", 1, target, "General");
    expect(sessionStorage.getItem(MARK)).toBeTruthy();

    const s2 = await load(); // F5
    await s2.maybeRejoin();
    expect(getActiveCallFn).toHaveBeenCalled();
    expect(s2.getCallSnapshot().joined).not.toBeNull();
  });

  it("COLGAR borra la marca: recargar NO vuelve a entrar aunque la llamada siga viva", async () => {
    const s1 = await load();
    await s1.openCall(joinCallFn, "room", 1, target, "General");
    s1.leaveCall();
    expect(sessionStorage.getItem(MARK)).toBeNull();
    expect(s1.getCallSnapshot().joined).toBeNull();

    joinCallFn.mockClear();
    const s2 = await load(); // F5 después de haber colgado
    await s2.maybeRejoin();
    // getActiveCallFn seguiría diciendo que hay llamada viva (los demás siguen dentro):
    // no basta, porque no hay marca. No se une ni se piden permisos.
    expect(joinCallFn).not.toHaveBeenCalled();
    expect(s2.getCallSnapshot().joined).toBeNull();
  });

  it("si la llamada ya terminó, la marca se limpia sin re-unirse", async () => {
    const s1 = await load();
    await s1.openCall(joinCallFn, "room", 1, target, "General");
    const s2 = await load();
    getActiveCallFn.mockResolvedValueOnce(null as never);
    joinCallFn.mockClear();
    await s2.maybeRejoin();
    expect(joinCallFn).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(MARK)).toBeNull();
  });

  it("terminar la llamada desde el server también borra la marca", async () => {
    const s = await load();
    await s.openCall(joinCallFn, "room", 1, target, "General");
    expect(sessionStorage.getItem(MARK)).toBeTruthy();
    s.endCallFromServer("room", 1);
    expect(sessionStorage.getItem(MARK)).toBeNull();
    expect(s.getCallSnapshot().joined).toBeNull();
  });
});
