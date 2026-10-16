import { describe, it, expect, vi, beforeEach } from "vitest";
import { deployVerdict, prodActionSmoke, smokeVerdict, type WorkflowRun } from "./post-merge.server";

// Producción por el guard de red: aquí se simula la respuesta de cada petición.
const guarded = vi.hoisted(() => ({ calls: [] as { url: string; method: string; headers: Record<string, string> }[], postStatus: 200 }));
vi.mock("../connectors/net-guard.server", () => ({
  guardedRequest: async (url: string, opts: { method?: string; headers?: Record<string, string> } = {}) => {
    const method = opts.method ?? "GET";
    guarded.calls.push({ url, method, headers: opts.headers ?? {} });
    if (method === "POST") return { status: guarded.postStatus, url, body: guarded.postStatus === 400 ? "origin does not match" : "" };
    // `denik.me` redirige a `www`: el POST tiene que ir al origen final.
    return { status: 200, url: "https://www.denik.me/", body: "<script>window.__reactRouterContext = {}</script>" };
  },
}));
vi.mock("./factory-team.server", () => ({ repoTeamFile: async () => null }));

const run = (name: string, status: string, conclusion: string | null = null): WorkflowRun => ({
  name,
  status,
  conclusion,
  html_url: `https://github.com/o/r/actions/runs/${name}`,
});

describe("deployVerdict", () => {
  it("mientras un workflow corre, se espera", () => {
    expect(deployVerdict([run("Fly Deploy", "in_progress")], 60)).toEqual({ kind: "running" });
    expect(deployVerdict([run("Fly Deploy", "queued"), run("Tests", "completed", "success")], 60)).toEqual({ kind: "running" });
  });

  it("todo verde", () => {
    expect(deployVerdict([run("Fly Deploy", "completed", "success"), run("Lint", "completed", "skipped")], 300)).toEqual({ kind: "green" });
  });

  it("uno falla y lo dice aunque otro siga corriendo", () => {
    const v = deployVerdict([run("Tests", "in_progress"), run("Fly Deploy", "completed", "failure")], 120);
    expect(v).toMatchObject({ kind: "failed", name: "Fly Deploy", conclusion: "failure" });
    expect(deployVerdict([run("Fly Deploy", "completed", "cancelled")], 120)).toMatchObject({ kind: "failed", conclusion: "cancelled" });
  });

  it("sin workflows: espera la gracia de 3 min y luego sólo smoke", () => {
    expect(deployVerdict([], 60)).toEqual({ kind: "running" });
    expect(deployVerdict([], 180)).toEqual({ kind: "none" });
  });

  it("tope de 30 min corriendo", () => {
    expect(deployVerdict([run("Fly Deploy", "in_progress")], 30 * 60)).toMatchObject({ kind: "timeout", name: "Fly Deploy" });
  });
});

describe("smokeVerdict", () => {
  it("200 pasa", () => {
    expect(smokeVerdict("https://denik.me/", { status: 200 })).toBeNull();
  });
  it("404 en la raíz falla; en otra ruta no", () => {
    expect(smokeVerdict("https://denik.me/", { status: 404 })).toBe("HTTP 404");
    expect(smokeVerdict("https://denik.me/planes", { status: 404 })).toBeNull();
  });
  it("5xx falla", () => {
    expect(smokeVerdict("https://denik.me/planes", { status: 502 })).toBe("HTTP 502");
  });
  it("timeout falla con su motivo", () => {
    expect(smokeVerdict("https://denik.me/", { error: "no contestó en 15 s" })).toBe("no contestó en 15 s");
  });
});

describe("prodActionSmoke", () => {
  beforeEach(() => {
    guarded.calls = [];
  });

  it("400 en el POST: falla con el motivo, contra el origen final", async () => {
    guarded.postStatus = 400;
    const why = await prodActionSmoke("https://denik.me", "denik/app", "sub");
    expect(why).toContain("POST /_root.data → 400: la app rechazó el envío (origen/CSRF)");
    const post = guarded.calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("https://www.denik.me/_root.data");
    expect(post.headers.origin).toBe("https://www.denik.me");
    expect(post.headers.cookie).toBeUndefined();
  });

  it("405 o 302 pasan", async () => {
    for (const s of [405, 302]) {
      guarded.postStatus = s;
      expect(await prodActionSmoke("https://denik.me", "denik/app", "sub")).toBeNull();
    }
  });

  it("sin homepage no corre", async () => {
    expect(await prodActionSmoke(null, "denik/app", "sub")).toBeNull();
    expect(guarded.calls).toHaveLength(0);
  });
});
