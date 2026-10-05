import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";

// Lo que gs reparte cuando alguien del repo le pide algo a Ghosty en el PR: un comentario con
// @ghosty o una review «Request changes». Le llega a @build como nota; una aprobación sólo se mide.
const asked: { runId: number; by: string; text: string }[] = [];
const reviews: { runId: number; state: string }[] = [];
let runs: { id: number; channelId: number }[] = [{ id: 10, channelId: 14 }];
let delivered = new Set<string>();

vi.mock("../server/schema.server", () => ({ ensureSchema: async () => {} }));
vi.mock("../dbq.server", () => ({
  dbq: async (sql: string, args: unknown[] = []) => {
    if (sql.startsWith("INSERT OR IGNORE INTO gt_github_deliveries")) {
      const d = String(args[0]);
      if (delivered.has(d)) return [];
      delivered.add(d);
      return [{ delivery: d }];
    }
    return [];
  },
}));
vi.mock("../db.server", () => ({ roomsOfRepo: async () => [] }));
vi.mock("../server/apps/factory-runs.server", () => ({
  runsByPr: async () => runs,
  recordFirstReview: async (runId: number, state: string) => (reviews.push({ runId, state }), true),
  noteFromGithub: async (run: { id: number }, by: string, ask: { text: string }) => (asked.push({ runId: run.id, by, text: ask.text }), "reopened"),
  onPrEvent: async () => {},
}));

process.env.GHOSTY_PARTNER_SECRET = "s3cr3t";
const { Route } = await import("./api.internal.github-event");
const post = (Route.options as any).server.handlers.POST as (c: { request: Request }) => Promise<Response>;

const send = async (ev: Record<string, unknown>) => {
  const raw = JSON.stringify(ev);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac("sha256", "s3cr3t").update(`${ts}.${raw}`).digest("hex");
  const res = await post({ request: new Request("http://x/api/internal/github-event", { method: "POST", headers: { "x-ghosty-ts": ts, "x-ghosty-sig": sig }, body: raw }) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const base = { repo: "o/r", number: 8, title: "CLI", url: "https://github.com/o/r/pull/8", author: "ghosty-studio[bot]", by: "bliss", draft: false };

beforeEach(() => {
  asked.length = 0;
  reviews.length = 0;
  runs = [{ id: 10, channelId: 14 }];
  delivered = new Set();
});

describe("pedidos desde GitHub", () => {
  it("comentario con @ghosty: le llega a @build", async () => {
    const r = await send({ ...base, delivery: "c1", action: "comment", ask: { text: "@ghosty quita eso", url: `${base.url}#issuecomment-1` } });
    expect(r.status).toBe(200);
    expect(asked).toEqual([{ runId: 10, by: "bliss", text: "@ghosty quita eso" }]);
    expect(r.body).toMatchObject({ asked: ["reopened"] });
  });

  it("review «Request changes»: se mide y además le llega a @build", async () => {
    await send({ ...base, delivery: "r1", action: "review", review: { state: "changes_requested", at: "2026-10-04T22:00:00Z" }, ask: { text: "falta la prueba", url: base.url } });
    expect(reviews).toEqual([{ runId: 10, state: "changes_requested" }]);
    expect(asked).toHaveLength(1);
  });

  it("aprobación: sólo se mide", async () => {
    await send({ ...base, delivery: "r2", action: "review", review: { state: "approved", at: "2026-10-04T22:00:00Z" } });
    expect(reviews).toHaveLength(1);
    expect(asked).toHaveLength(0);
  });

  it("PR que no es de la fábrica: nadie lo recibe", async () => {
    runs = [];
    const r = await send({ ...base, delivery: "c2", action: "comment", ask: { text: "@ghosty x", url: base.url } });
    expect(r.body).toMatchObject({ asked: [] });
  });

  it("reenvío de la misma entrega: no se repite", async () => {
    const ev = { ...base, delivery: "c3", action: "comment", ask: { text: "@ghosty x", url: base.url } };
    await send(ev);
    const again = await send(ev);
    expect(again.body).toMatchObject({ repeated: true });
    expect(asked).toHaveLength(1);
  });

  it("firma mala: 403", async () => {
    const res = await post({ request: new Request("http://x", { method: "POST", headers: { "x-ghosty-ts": "1", "x-ghosty-sig": "nope" }, body: "{}" }) });
    expect(res.status).toBe(403);
  });
});
