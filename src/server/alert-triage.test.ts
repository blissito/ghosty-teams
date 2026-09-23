import { beforeEach, describe, expect, it, vi } from "vitest";

// Cada alerta NUEVA de #soporte la revisa @ghosty en su hilo; una vez por problema al día.
const dbq = vi.fn();
const enqueueWakeup = vi.fn(async (_w: unknown) => true);
const mintWakeRef = vi.fn((_r: unknown) => "ref");
vi.mock("../dbq.server", () => ({ dbq: (...a: unknown[]) => dbq(...a), num: (v: unknown) => Number(v) }));
vi.mock("../agents.server", () => ({
  resolvedAgents: async () => [{ handle: "ghosty", name: "Ghosty", avatar: "" }],
  agentGroupId: async (_a: unknown, s: string) => `ghosty-chat-ghosty-${s}`,
}));
vi.mock("./wakeups.server", () => ({
  enqueueWakeup: (w: unknown) => enqueueWakeup(w),
  mintWakeRef: (r: unknown) => mintWakeRef(r),
  armWakeups: () => {},
}));

const { enqueueAlertTriage, alertKey, worthTriage } = await import("./alert-triage.server");

beforeEach(() => {
  vi.clearAllMocks();
  dbq.mockResolvedValue([{ sub: "u_owner" }]);
});

describe("revisión de alertas de #soporte", () => {
  it("una alerta → un despertador en SU hilo, a nombre del dueño", async () => {
    expect(await enqueueAlertTriage({ ns: "ns", roomId: 3, alertId: 3548, title: "⚠️ Promesa rechazada sin dueño (gs)", detail: "PrismaClientValidationError:\nInvalid ...", origin: "https://b" })).toBe(true);
    const ref = mintWakeRef.mock.calls[0][0] as { sub: string; dest: { parentId: number; channelId: number } };
    expect(ref.sub).toBe("u_owner");
    expect(ref.dest).toMatchObject({ channelId: 3, parentId: 3548 });
    expect((enqueueWakeup.mock.calls[0][0] as { text: string }).text).toContain("PrismaClientValidationError");
  });

  it("el mismo problema el mismo día → misma key (enqueueWakeup lo deduplica)", () => {
    const t = Date.UTC(2026, 8, 23, 10);
    expect(alertKey("⚠️ X", "Err: a\nstack 1", t)).toBe(alertKey("⚠️ X", "Err: a\nstack 2", t + 3600_000));
    expect(alertKey("⚠️ X", "Err: a", t)).not.toBe(alertKey("⚠️ X", "Err: b", t));
    expect(alertKey("⚠️ X", "Err: a", t)).not.toBe(alertKey("⚠️ X", "Err: a", t + 86_400_000));
  });

  it("las recuperaciones no se revisan", async () => {
    expect(worthTriage("🔴 studio se recuperó")).toBe(false);
    expect(await enqueueAlertTriage({ ns: "ns", roomId: 3, alertId: 1, title: "🔴 studio se recuperó", origin: "https://b" })).toBe(false);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("sin dueño no hay a nombre de quién trabajar → no encola", async () => {
    dbq.mockResolvedValue([]);
    expect(await enqueueAlertTriage({ ns: "ns", roomId: 3, alertId: 1, title: "⚠️ X", origin: "https://b" })).toBe(false);
  });
});
