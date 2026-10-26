import { beforeEach, describe, expect, it, vi } from "vitest";

// Lo que hace una vigilancia de PR (`github_watch_pr`) cuando GitHub avisa: despertar UNA vez a
// la conversación que la pidió, con el porqué y las ligas de lo que falló. Las trampas que
// cuida: un evento repetido no despierta dos veces (la reclamación es atómica), un PR de un
// pedido de la fábrica ya terminado no mete ruido en el hilo (la plataforma ya lo atiende), y
// sin cambio de veredicto sólo se guarda la memoria.
type Row = { id: string; repo: string; number: number; sub: string; ref: string; origin: string; last_sha: string; last_checks: string; green_since: null; done_at: number | null };
let rows: Row[] = [];
let factoryDone = false;
/** Lectura vieja: el SELECT sigue viendo la vigilancia aunque otro barrido ya la reclamó. */
let staleRead = false;
const sqls: string[] = [];

vi.mock("../dbq.server", () => ({
  num: (v: unknown) => Number(v),
  dbq: async (sql: string, args: unknown[] = []) => {
    sqls.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
    if (sql.startsWith("SELECT * FROM gt_pr_watches")) return rows.filter((r) => staleRead || r.done_at == null);
    if (sql.includes("SET done_at=unixepoch(), result=? WHERE id=?")) {
      const r = rows.find((x) => x.id === args[1] && x.done_at == null);
      if (!r) return [];
      r.done_at = 1;
      return [{ id: r.id }];
    }
    if (sql.startsWith("SELECT id FROM gt_factory_runs")) return factoryDone ? [{ id: 1 }] : [];
    return [];
  },
}));
vi.mock("./tenant.server", () => ({ withNamespace: async (_ns: string, fn: () => Promise<unknown>) => fn(), currentNamespace: async () => "acme" }));

let snap: unknown = null;
let verdict: { notice: string | null; memory: { sha: string; checks: string; greenSince: null } } = { notice: null, memory: { sha: "b", checks: "green", greenSince: null } };
vi.mock("./connectors/github.server", () => ({ prSnapshot: async () => snap }));
vi.mock("./connectors/github-checks", () => ({ prWatchVerdict: () => verdict }));
const wakes: { key: string; text: string; ref: string }[] = [];
vi.mock("./wakeups.server", () => ({ enqueueWakeup: async (w: { key: string; text: string; ref: string }) => void wakes.push(w) }));

const { onRepoEvent } = await import("./pr-watches.server");

const ev = (action = "synchronize", number = 8) => ({ event: "pull_request", action, repo: "o/app", pr: { number } });

beforeEach(() => {
  rows = [{ id: "w1", repo: "o/app", number: 8, sub: "ana", ref: "REF", origin: "https://acme.teams", last_sha: "a", last_checks: "pending", green_since: null, done_at: null }];
  factoryDone = false;
  staleRead = false;
  sqls.length = 0;
  wakes.length = 0;
  snap = { state: "open", merged: false, checks: { failed: [] } };
  verdict = { notice: "PR o/app#8: CI en verde", memory: { sha: "b", checks: "green", greenSince: null } };
});

describe("vigilancia de PR al llegar un evento", () => {
  it("despierta UNA vez a la conversación, con su ref y una llave estable", async () => {
    await onRepoEvent("acme", ev());
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ ref: "REF", key: "pr:w1:b:green:open" });
    expect(wakes[0].text).toContain("[Aviso de GitHub] PR o/app#8: CI en verde");
  });

  it("un segundo barrido que todavía lee la vigilancia abierta (evento + tick): un solo despertar", async () => {
    staleRead = true;
    await onRepoEvent("acme", ev());
    await onRepoEvent("acme", ev());
    expect(wakes).toHaveLength(1);
  });

  it("CI rojo: el aviso trae a lo más 5 ligas de lo que falló", async () => {
    snap = { state: "open", merged: false, checks: { failed: Array.from({ length: 8 }, (_, i) => ({ name: `job${i}`, url: `https://x/${i}` })) } };
    verdict = { notice: "PR o/app#8: CI en rojo", memory: { sha: "b", checks: "red" as never, greenSince: null } };
    await onRepoEvent("acme", ev());
    const links = wakes[0].text.split("\n").filter((l) => l.startsWith("job"));
    expect(links).toHaveLength(5);
  });

  it("PR de un pedido de la fábrica ya en revisión o cerrado: se cierra sin despertar a nadie", async () => {
    factoryDone = true;
    await onRepoEvent("acme", ev());
    expect(wakes).toHaveLength(0);
    expect(rows[0].done_at).toBe(1);
  });

  it("sin cambio de veredicto sólo se guarda la memoria", async () => {
    verdict = { notice: null, memory: { sha: "b", checks: "pending" as never, greenSince: null } };
    await onRepoEvent("acme", ev());
    expect(wakes).toHaveLength(0);
    expect(sqls).toContain("UPDATE gt_pr_watches SET");
    expect(rows[0].done_at).toBeNull();
  });

  it("GitHub no contesta el snapshot: no se reclama ni se despierta", async () => {
    snap = { error: "rate limit" };
    await onRepoEvent("acme", ev());
    expect(wakes).toHaveLength(0);
    expect(rows[0].done_at).toBeNull();
  });

  it("un evento que no cambia el veredicto (etiqueta) ni siquiera consulta la base", async () => {
    await onRepoEvent("acme", ev("labeled"));
    expect(sqls.some((s) => s.startsWith("SELECT"))).toBe(false);
    expect(wakes).toHaveLength(0);
  });
});
