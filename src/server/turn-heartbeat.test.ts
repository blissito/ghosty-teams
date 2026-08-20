import { beforeEach, describe, expect, it, vi } from "vitest";

// El LATIDO es lo que distingue "el agente está trabajando" de "el proceso que lo atendía ya
// no existe". Sin él, el barrido de huérfanos ADIVINABA por la edad del mensaje, y esa
// adivinanza ya había fallado en las dos direcciones: cerraba turnos legítimos de un motor
// lento, y dejaba burbujas en "pensando" para siempre tras un despliegue solapado.
//
// Estos tests fijan las tres propiedades que hacen que barrer sea seguro: que se compare con
// el reloj de la BASE, que sólo muera quien no late, y que cada tenant lata en SU base.
const dbq = vi.fn();
const withNamespace = vi.fn(async (_ns: string, fn: () => Promise<unknown>) => fn());

vi.mock("../dbq.server", () => ({ dbq: (...a: unknown[]) => dbq(...a), num: (v: unknown) => Number(v) }));
vi.mock("./tenant.server", () => ({ withNamespace: (ns: string, fn: () => Promise<unknown>) => withNamespace(ns, fn) }));

const turns = await import("./turns.server");

const sqls = () => dbq.mock.calls.map((c) => String(c[0]));
/**
 * `persistir` es fire-and-forget (`void`) y además hace un `import()` dinámico, así que sus
 * escrituras tardan varios ticks en aterrizar. Se espera a que APAREZCA lo que se busca en
 * vez de dormir un rato fijo, que es como se escriben los tests que fallan una vez al mes.
 */
const hasta = async (pred: () => boolean, ticks = 20) => {
  for (let i = 0; i < ticks && !pred(); i++) await new Promise((r) => setTimeout(r, 1));
  return pred();
};

beforeEach(() => {
  vi.resetAllMocks();
  dbq.mockResolvedValue([]);
  withNamespace.mockImplementation(async (_ns: string, fn: () => Promise<unknown>) => fn());
});

describe("el latido", () => {
  it("se escribe con el reloj de la BASE, no con el de Node", async () => {
    // Escribir el latido con `Date.now()` y compararlo en el WHERE con `unixepoch()` son dos
    // relojes distintos: el desfase se manifiesta como turnos cerrados a destiempo, que es
    // justo el fallo que este mecanismo viene a quitar.
    turns.registerTurn({ ns: "acme", messageId: 1, groupId: "g", agent: "Ghosty" } as never);
    await hasta(() => sqls().some((x) => x.includes("heartbeat_at")));
    const latidos = sqls().filter((s) => s.includes("heartbeat_at"));
    expect(latidos.length).toBeGreaterThan(0);
    for (const s of latidos) {
      // El valor del latido SIEMPRE es `unixepoch()`; nunca un timestamp de Node como
      // parámetro. Son dos relojes distintos y el desfase cierra turnos a destiempo.
      expect(s).toMatch(/heartbeat_at\s*=\s*unixepoch\(\)|heartbeat_at[\s\S]*unixepoch\(\)/);
    }
    turns.finishTurn("acme", 1);
  });

  it("un turno recién nacido YA late — si no, otro proceso lo daría por muerto al instante", async () => {
    turns.registerTurn({ ns: "acme", messageId: 2, groupId: "g", agent: "Ghosty" } as never);
    // Va DENTRO del INSERT: una escritura aparte deja un hueco en el que la fila existe sin
    // latido, y cualquier barrido que corra ahí la mata.
    expect(await hasta(() => sqls().some((x) => x.includes("INSERT INTO gt_turns")))).toBe(true);
    const ins = sqls().find((x) => x.includes("INSERT INTO gt_turns"))!;
    expect(ins).toContain("heartbeat_at");
    expect(ins).toContain("unixepoch()");
    turns.finishTurn("acme", 2);
  });
});

describe("el barrido", () => {
  it("sólo mata a quien NO late, y lo dice", async () => {
    dbq.mockResolvedValue([]);
    await turns.sweepOrphans();
    const upd = sqls().find((s) => s.includes("state = 'expired'")) ?? "";
    expect(upd).toContain("state = 'running'");
    expect(upd).toContain("heartbeat_at IS NULL OR heartbeat_at < unixepoch()");
    // `error` poblado: un turno muerto y uno interrumpido tienen que poder distinguirse.
    expect(upd).toContain("error");
  });

  it("cierra SÓLO las cáscaras de los que acaba de dar por muertos", async () => {
    // Antes barría por edad del mensaje (60 s / 600 s) sobre TODA la tabla, que es de donde
    // salían los falsos positivos: un motor lento se llevaba un "Detenido" encima.
    dbq.mockResolvedValueOnce([{ message_id: 7 }, { message_id: 9 }]).mockResolvedValue([]);
    const n = await turns.sweepOrphans();
    expect(n).toBe(2);
    const mensajes = sqls().filter((s) => s.includes("gc_messages"));
    expect(mensajes.length).toBe(2);
    for (const s of mensajes) {
      expect(s).toContain("id IN (7,9)");
      expect(s).not.toMatch(/created_at/); // ya no se adivina por edad
    }
  });

  it("no toca nada si nadie murió", async () => {
    dbq.mockResolvedValue([]);
    expect(await turns.sweepOrphans()).toBe(0);
    expect(sqls().filter((s) => s.includes("gc_messages")).length).toBe(0);
  });

  it("un fallo de la base no tumba el arranque del tenant", async () => {
    dbq.mockRejectedValue(new Error("base caída"));
    await expect(turns.sweepOrphans()).resolves.toBe(0);
  });
});

describe("multitenant", () => {
  it("el barrido periódico entra con withNamespace en CADA tenant", async () => {
    // El tick corre FUERA de un request: sin `withNamespace`, `dbq` cae al namespace del env
    // y barrería la base de UN workspace creyendo que son todos. Misma trampa documentada en
    // reminders y en sentry-enrich.
    vi.useFakeTimers();
    turns.armTurnSweep("acme");
    turns.armTurnSweep("otra");
    await vi.advanceTimersByTimeAsync(61_000);
    const vistos = withNamespace.mock.calls.map((c) => c[0]);
    expect(vistos).toContain("acme");
    expect(vistos).toContain("otra");
    vi.useRealTimers();
  });
});
