import { describe, it, expect, vi } from "vitest";
import {
  makeSecurityFix,
  meetsSeverity,
  severityRank,
  buildSecretNotice,
  batchKey,
  BATCH_WINDOW_S,
  MAX_ATTEMPTS,
} from "./security-fix.server";
import type { AutomationCtx, RepoEvent } from "./types";

// ctx de mentira: `claim` con memoria real (clave → vence), lo demás espiado.
function fakeCtx(settings: Record<string, unknown> = {}, budget = true) {
  const claims = new Map<string, number>();
  let clock = 1_000_000;
  const ctx = {
    ns: "acme",
    roomId: "10",
    repo: "acme/web",
    wake: vi.fn(async () => {}),
    claim: vi.fn(async (_k: string, key: string, ttl = 60_000) => {
      const exp = claims.get(key);
      if (exp != null && exp > clock) return false;
      claims.set(key, clock + ttl);
      return true;
    }),
    budget: vi.fn(async () => budget),
    settings: vi.fn(async () => settings),
  } as unknown as AutomationCtx & { wake: ReturnType<typeof vi.fn>; budget: ReturnType<typeof vi.fn> };
  return { ctx, advance: (ms: number) => (clock += ms) };
}

const codeAlert = (n: number, severity = "high", action = "created"): RepoEvent => ({
  deliveryId: `d${n}${action}`,
  event: "code_scanning_alert",
  action,
  repo: "acme/web",
  sender: { login: "github-advanced-security[bot]", type: "Bot" },
  alert: { kind: "code_scanning", number: n, severity, rule: "js/sql-injection", url: `https://github.com/acme/web/security/code-scanning/${n}` },
});

describe("umbral de severidad", () => {
  it("mapea las dos escalas de GitHub", () => {
    expect(severityRank("critical")).toBe(4);
    expect(severityRank("error")).toBe(3);
    expect(severityRank("moderate")).toBe(2);
    expect(severityRank("note")).toBe(1);
    expect(severityRank("rara")).toBe(0);
  });
  it("default high: medium no pasa, critical sí, desconocida nunca", () => {
    expect(meetsSeverity("medium", undefined)).toBe(false);
    expect(meetsSeverity("critical", undefined)).toBe(true);
    expect(meetsSeverity(undefined, "low")).toBe(false);
    expect(meetsSeverity("medium", "medium")).toBe(true);
  });
});

describe("security_fix", () => {
  const deps = () => ({ postNotice: vi.fn(async (_c: AutomationCtx, _b: string) => {}), now: () => Date.UTC(2026, 9, 25, 18) });

  it("ignora lo que está bajo el umbral del room", async () => {
    const { ctx } = fakeCtx({ minSeverity: "critical" });
    await makeSecurityFix(deps()).handle(codeAlert(1, "high"), ctx);
    expect(ctx.wake).not.toHaveBeenCalled();
  });

  it("agrupa: 30 alertas en la ventana = UN turno de @build, con retraso", async () => {
    const { ctx } = fakeCtx();
    const a = makeSecurityFix(deps());
    for (let n = 1; n <= 30; n++) await a.handle(codeAlert(n, "critical"), ctx);
    expect(ctx.wake).toHaveBeenCalledTimes(1);
    const opts = ctx.wake.mock.calls[0][0];
    expect(opts.handle).toBe("build");
    expect(opts.delayS).toBe(BATCH_WINDOW_S);
    expect(opts.text).toContain("ghosty/security-fix-2026-10-25");
    expect(opts.text).toContain("Nunca descartes");
    expect(ctx.claim).toHaveBeenCalledWith("security_fix", batchKey("acme/web"), BATCH_WINDOW_S * 1000);
  });

  it("pasada la ventana, otra alerta abre otro lote", async () => {
    const { ctx, advance } = fakeCtx();
    const a = makeSecurityFix(deps());
    await a.handle(codeAlert(1), ctx);
    advance(BATCH_WINDOW_S * 1000 + 1);
    await a.handle(codeAlert(2), ctx);
    expect(ctx.wake).toHaveBeenCalledTimes(2);
  });

  it("máximo 3 intentos por alerta aunque la reabran más veces", async () => {
    const { ctx, advance } = fakeCtx();
    const a = makeSecurityFix(deps());
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
      await a.handle(codeAlert(7, "high", "reopened"), ctx);
      advance(BATCH_WINDOW_S * 1000 + 1);
    }
    expect(ctx.wake).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  it("anti-bucle y presupuesto", async () => {
    const { ctx } = fakeCtx({}, false);
    const a = makeSecurityFix(deps());
    await a.handle({ ...codeAlert(1), sender: { login: "ghosty-studio[bot]" } }, ctx);
    await a.handle(codeAlert(2), ctx);
    expect(ctx.wake).not.toHaveBeenCalled();
  });

  it("dismissed/fixed no despiertan a nadie", async () => {
    const { ctx } = fakeCtx();
    await makeSecurityFix(deps()).handle(codeAlert(1, "critical", "fixed"), ctx);
    expect(ctx.wake).not.toHaveBeenCalled();
  });
});

describe("secret scanning: el secreto jamás viaja", () => {
  const SECRET = "ghp_SuperSecreto1234567890abcdef";
  const ev: RepoEvent = {
    deliveryId: "s1",
    event: "secret_scanning_alert",
    action: "created",
    repo: "acme/web",
    alert: {
      kind: "secret_scanning",
      number: 3,
      rule: "GitHub Personal Access Token",
      url: "https://github.com/acme/web/security/secret-scanning/3",
      // Lo que NO debería venir, pero si gs se equivoca no puede salir de aquí.
      ...({ secret: SECRET, state: SECRET } as object),
    } as RepoEvent["alert"],
  };

  it("avisa directo en el room, sin turno de agente, y sin el valor", async () => {
    const { ctx } = fakeCtx();
    const d = { postNotice: vi.fn(async (_c: AutomationCtx, _b: string) => {}), now: () => Date.now() };
    await makeSecurityFix(d).handle(ev, ctx);
    expect(ctx.wake).not.toHaveBeenCalled();
    expect(d.postNotice).toHaveBeenCalledTimes(1);
    const body = d.postNotice.mock.calls[0][1];
    expect(body).toContain("Rota esa credencial");
    expect(body).toContain("https://github.com/acme/web/security/secret-scanning/3");
    expect(body).not.toContain(SECRET);
    expect(JSON.stringify(d.postNotice.mock.calls)).not.toContain(SECRET);
  });

  it("un reintento de gs no repite el aviso", async () => {
    const { ctx } = fakeCtx();
    const d = { postNotice: vi.fn(async (_c: AutomationCtx, _b: string) => {}), now: () => Date.now() };
    const a = makeSecurityFix(d);
    await a.handle(ev, ctx);
    await a.handle(ev, ctx);
    expect(d.postNotice).toHaveBeenCalledTimes(1);
  });

  it("una liga que no es de GitHub no se pega", () => {
    const body = buildSecretNotice("acme/web", { kind: "secret_scanning", number: 1, url: "https://evil.example/x" });
    expect(body).not.toContain("evil.example");
  });
});
