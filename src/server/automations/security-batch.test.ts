import { describe, it, expect, vi } from "vitest";
import {
  makeSecurityFix,
  coveringPr,
  planBatch,
  batchPlanMd,
  securityTitle,
  sweepSecurityAlerts,
  sweepTrigger,
  BATCH_WINDOW_S,
  MAX_ALERTS_PER_PR,
  type DepPr,
  type OpenAlert,
} from "./security-fix.server";
import type { AutomationCtx, RepoEvent } from "./types";

function fakeCtx() {
  const claims = new Map<string, number>();
  let clock = 1_000_000;
  const ctx = {
    ns: "acme",
    roomId: "10",
    repo: "acme/web",
    wake: vi.fn(async () => {}),
    post: vi.fn(async () => {}),
    claim: vi.fn(async (_k: string, key: string, ttl = 60_000) => {
      const exp = claims.get(key);
      if (exp != null && exp > clock) return false;
      claims.set(key, clock + ttl);
      return true;
    }),
    budget: vi.fn(async () => true),
    settings: vi.fn(async () => ({})),
  } as unknown as AutomationCtx & { wake: ReturnType<typeof vi.fn>; claim: ReturnType<typeof vi.fn> };
  return { ctx, advance: (ms: number) => (clock += ms) };
}

const dep = (number: number, pkg: string, severity = "high"): OpenAlert => ({ kind: "dependabot", number, package: pkg, severity, url: `https://github.com/acme/web/security/dependabot/${number}` });
const code = (number: number, severity = "high"): OpenAlert => ({ kind: "code_scanning", number, severity, rule: "js/xss" });
const pr = (number: number, title: string, head: string, body = ""): DepPr => ({ number, title, head, body, url: `https://github.com/acme/web/pull/${number}` });

describe("alerta ↔ PR de Dependabot", () => {
  const prs = [
    pr(34, "Bump lodash from 4.17.20 to 4.17.21", "dependabot/npm_and_yarn/lodash-4.17.21"),
    pr(35, "Bump @babel/traverse from 7.22.0 to 7.23.2", "dependabot/npm_and_yarn/babel/traverse-7.23.2"),
    pr(36, "Bump the npm_and_yarn group with 2 updates", "dependabot/npm_and_yarn/npm_and_yarn-abc", "Bumps the npm_and_yarn group with 2 updates: [semver](https://x) and [ws](https://y)."),
  ];
  it("por título, por rama y por cuerpo de grupo", () => {
    expect(coveringPr(dep(1, "lodash"), prs)?.number).toBe(34);
    expect(coveringPr(dep(2, "@babel/traverse"), prs)?.number).toBe(35);
    expect(coveringPr(dep(3, "ws"), prs)?.number).toBe(36);
    expect(coveringPr(dep(4, "semver"), prs)?.number).toBe(36);
  });
  it("palabra completa: lodash-es no es lodash; code scanning nunca", () => {
    expect(coveringPr(dep(5, "lodash-es"), prs)).toBeNull();
    expect(coveringPr(dep(6, "lodash"), [pr(40, "Bump lodash-es from 1 to 2", "dependabot/npm_and_yarn/lodash-es-2.0.0")])).toBeNull();
    expect(coveringPr(code(7), prs)).toBeNull();
  });
});

describe("el lote", () => {
  it("salta las cubiertas, filtra por severidad y ordena por gravedad", () => {
    const { candidates, covered } = planBatch(
      [code(9, "high"), dep(1, "lodash", "critical"), code(3, "critical"), code(4, "low"), dep(2, "axios", "high")],
      [pr(34, "Bump lodash from 1 to 2", "dependabot/npm_and_yarn/lodash-2.0.0")],
      "high",
    );
    expect(candidates.map((a) => `${a.kind}#${a.number}`)).toEqual(["code_scanning#3", "dependabot#2", "code_scanning#9"]);
    expect(covered).toEqual([{ alert: expect.objectContaining({ number: 1 }), pr: 34 }]);
  });
  it("el plan cita «la cubre #N» y lista las que tocan", () => {
    const md = batchPlanMd({ repo: "acme/web", take: [code(3, "critical")], covered: [{ alert: dep(1, "lodash"), pr: 34 }], minSeverity: "high", date: "2026-10-25", factory: true });
    expect(md).toContain("Arregla estas 1");
    expect(md).toContain("code scanning #3");
    expect(md).toContain("Dependabot #1 · paquete `lodash`");
    expect(md).toContain("— la cubre #34");
    expect(md).toContain("ghosty/security-fix-2026-10-25");
    expect(md).toContain("Criterio para @check");
  });
  it("título con el conteo", () => {
    expect(securityTitle(1, "acme/web", "2026-10-25")).toBe("Seguridad: 1 alerta · acme/web · 2026-10-25");
    expect(securityTitle(3, "acme/web", "2026-10-25")).toBe("Seguridad: 3 alertas · acme/web · 2026-10-25");
  });
});

const ev = (n: number, alert: Partial<NonNullable<RepoEvent["alert"]>> = {}): RepoEvent => ({
  deliveryId: `d${n}`,
  event: "dependabot_alert",
  action: "created",
  repo: "acme/web",
  sender: { login: "dependabot[bot]", type: "Bot" },
  alert: { kind: "dependabot", number: n, severity: "critical", package: "lodash", ...alert },
});

describe("webhook con fábrica: pedido diferido", () => {
  const NOW = Date.UTC(2026, 9, 25, 18);
  it("el pedido arranca a los 10 min y guarda la primera alerta", async () => {
    const { ctx } = fakeCtx();
    const openFactoryRun = vi.fn(async () => "opened" as const);
    await makeSecurityFix({ openFactoryRun, coveredBy: async () => null, now: () => NOW }).handle(ev(5), ctx);
    expect(openFactoryRun).toHaveBeenCalledTimes(1);
    const o = (openFactoryRun.mock.calls[0] as any[])[1];
    expect(o.dueAt).toBe(Math.floor(NOW / 1000) + BATCH_WINDOW_S);
    expect(o.kindMeta).toEqual({ minSeverity: "high", first: "dependabot#5", alerts: 1 });
  });
  it("si ya la sube un PR de Dependabot no se abre nada", async () => {
    const { ctx } = fakeCtx();
    const openFactoryRun = vi.fn(async () => "opened" as const);
    await makeSecurityFix({ openFactoryRun, coveredBy: async () => 34, now: () => NOW }).handle(ev(5), ctx);
    expect(openFactoryRun).not.toHaveBeenCalled();
    expect(ctx.wake).not.toHaveBeenCalled();
  });
});

describe("barrido de alertas", () => {
  const base = (over: Record<string, unknown> = {}) => {
    const { ctx, advance } = fakeCtx();
    const openFactoryRun = vi.fn(async () => "opened" as "opened" | "busy" | "no_factory");
    const d = {
      openFactoryRun,
      rows: async () => [{ roomId: 10, repo: "acme/web", settings: {} }],
      liveRuns: vi.fn(async () => 0),
      lastClosedAt: vi.fn(async () => 0),
      ctxOf: () => ctx,
      sub: async () => "u1",
      alerts: vi.fn(async () => [code(3, "critical"), dep(1, "lodash"), dep(2, "axios")] as OpenAlert[] | null),
      depPrs: async () => [pr(34, "Bump lodash from 1 to 2", "dependabot/npm_and_yarn/lodash-2.0.0")],
      now: () => Date.UTC(2026, 9, 25, 18),
      ...over,
    };
    return { ctx, advance, d, openFactoryRun };
  };

  it("abre un pedido con las que nadie cubre y cita la cubierta", async () => {
    const { d, openFactoryRun } = base();
    expect(await sweepSecurityAlerts("t1", d)).toBe(1);
    const o = (openFactoryRun.mock.calls[0] as any[])[1];
    expect(o.title).toBe("Seguridad: 2 alertas · acme/web · 2026-10-25");
    expect(o.dueAt).toBeUndefined();
    expect(o.planMd).toContain("— la cubre #34");
    expect(o.kindMeta).toMatchObject({ alerts: 2, covered: [{ alert: "dependabot#1", pr: 34 }] });
  });

  it("con un pedido de seguridad vivo no barre", async () => {
    const { d, openFactoryRun } = base({ liveRuns: async () => 1 });
    expect(await sweepSecurityAlerts("t2", d)).toBe(0);
    expect(openFactoryRun).not.toHaveBeenCalled();
  });

  it("por horario: una vez cada 6 h", async () => {
    const { d, openFactoryRun, advance } = base();
    await sweepSecurityAlerts("t3", d);
    advance(BATCH_WINDOW_S * 1000 + 1);
    await sweepSecurityAlerts("t3", d);
    expect(openFactoryRun).toHaveBeenCalledTimes(1);
    advance(6 * 3600_000);
    await sweepSecurityAlerts("t3", d);
    expect(openFactoryRun).toHaveBeenCalledTimes(2);
  });

  it("al cerrarse el pedido vivo barre sin esperar el horario", async () => {
    let closed = 100;
    const { d, openFactoryRun, advance } = base({ lastClosedAt: async () => closed });
    await sweepSecurityAlerts("t4", d);
    advance(BATCH_WINDOW_S * 1000 + 1);
    closed = 200;
    await sweepSecurityAlerts("t4", d);
    expect(openFactoryRun).toHaveBeenCalledTimes(2);
  });

  it("todas cubiertas o sin respuesta de GitHub: nada", async () => {
    const a = base({ alerts: async () => [dep(1, "lodash")] });
    expect(await sweepSecurityAlerts("t5", a.d)).toBe(0);
    const b = base({ alerts: async () => null });
    expect(await sweepSecurityAlerts("t6", b.d)).toBe(0);
  });

  it("sin fábrica: turno de @build con la lista, sin retraso", async () => {
    const { d, ctx } = base({ openFactoryRun: vi.fn(async () => "no_factory" as const) });
    await sweepSecurityAlerts("t7", d);
    expect(ctx.wake).toHaveBeenCalledTimes(1);
    const w = (ctx.wake.mock.calls[0] as any[])[0];
    expect(w.handle).toBe("build");
    expect(w.delayS).toBeUndefined();
    expect(w.text).toContain("Al terminar, deja aquí la liga del PR");
  });

  it("tope de alertas por lote", async () => {
    const many = Array.from({ length: 40 }, (_, i) => code(i + 1, "critical"));
    const { d, openFactoryRun } = base({ alerts: async () => many });
    await sweepSecurityAlerts("t8", d);
    expect((openFactoryRun.mock.calls[0] as any[])[1].kindMeta.alerts).toBe(MAX_ALERTS_PER_PR);
  });

  it("disparo por cierre", () => {
    expect(sweepTrigger(undefined, 50)).toBeNull();
    expect(sweepTrigger(50, 50)).toBeNull();
    expect(sweepTrigger(50, 60)).toBe("closed");
  });
});
