import { beforeEach, describe, expect, it, vi } from "vitest";

// Un deploy mata los turnos en vuelo. Si el turno era un TRABAJO LARGO (su burbuja trae plan
// con tareas sin terminar) se retoma solo, una vez, por un despertador. Si no, se queda el
// botón «Retomar» de siempre. Estos tests fijan esa frontera.
const dbq = vi.fn();
const getMessage = vi.fn();
const enqueueWakeup = vi.fn(async (_w: unknown) => true);
vi.mock("../dbq.server", () => ({ dbq: (...a: unknown[]) => dbq(...a), num: (v: unknown) => Number(v) }));
vi.mock("./tenant.server", () => ({ withNamespace: (_ns: string, fn: () => Promise<unknown>) => fn() }));
vi.mock("../db.server", () => ({ getMessage: (id: number) => getMessage(id) }));
vi.mock("./wakeups.server", () => ({
  enqueueWakeup: (w: unknown) => enqueueWakeup(w),
  mintWakeRef: () => "ref",
  armWakeups: () => {},
}));

const turns = await import("./turns.server");
const { renderTodosBlock } = await import("../lib/ebdoc");

const filaMuerta = {
  message_id: 5, group_id: "g", invoker_sub: "u_boris", channel_id: 1, parent_id: 9, dm_id: null,
  slug: "general", shell_id: 50, agent: "Lens", agent_handle: "lens", body: "Use lean para verificar",
  attachments: null, tools_json: '["Bash","TodoWrite"]', error: "el proceso dejó de latir", state: "expired",
  outcome: null, ended_at: Date.now(),
};

beforeEach(() => {
  vi.resetAllMocks();
  enqueueWakeup.mockResolvedValue(true);
  dbq.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM gt_turns WHERE message_id") && sql.includes("dest_json"))
      return [{ origin: "https://business.teams.ghosty.studio", dest_json: '{"channelId":1,"parentId":9,"handle":"lens"}' }];
    if (sql.includes("FROM gt_turns WHERE message_id")) return [filaMuerta];
    return [];
  });
});

describe("auto-retomar tras un deploy", () => {
  it("turno con plan pendiente → un despertador en el mismo hilo, con el plan y lo ya hecho", async () => {
    getMessage.mockResolvedValue({
      body: renderTodosBlock({ todos: [{ content: "Modelar", status: "completed" }, { content: "Probar", status: "in_progress" }] }) + "Iba a medias",
    });
    expect(await turns.autoRetomarConPlan("acme", 5)).toBe(true);
    const w = enqueueWakeup.mock.calls[0][0] as unknown as { key: string; text: string; origin: string };
    expect(w.key).toBe("retomar:5");
    expect(w.origin).toBe("https://business.teams.ghosty.studio");
    expect(w.text).toContain("✓ Modelar");
    expect(w.text).toContain("✱ Probar");
    expect(w.text).toContain("Ya alcanzaste a ejecutar: Bash, TodoWrite");
  });

  it("turno SIN plan → no se retoma solo (queda el botón)", async () => {
    getMessage.mockResolvedValue({ body: "respuesta corta a medias" });
    expect(await turns.autoRetomarConPlan("acme", 5)).toBe(false);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("plan ya terminado → nada que retomar", async () => {
    getMessage.mockResolvedValue({ body: renderTodosBlock({ todos: [{ content: "Modelar", status: "completed" }] }) });
    expect(await turns.autoRetomarConPlan("acme", 5)).toBe(false);
  });
});
