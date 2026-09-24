import { describe, it, expect, vi, beforeEach } from "vitest";

let files: Record<string, boolean> = {};
let checkRuns: string[] = [];
const posts: { path: string; body: any; method?: string }[] = [];

vi.mock("../connectors/github.server", () => ({
  githubApi: async (_sub: string, path: string, init?: RequestInit) => {
    if (init?.method) {
      posts.push({ path, body: JSON.parse(String(init.body)), method: init.method });
      return { id: 9 };
    }
    if (path === "/repos/acme/app") return { default_branch: "main", owner: { login: "acme", type: "User" } };
    const m = /^\/repos\/([^/]+\/[^/]+)\/commits\/(v\d+)$/.exec(path);
    if (m) return { sha: `${m[1].replace("/", "-")}-${m[2]}-sha` };
    if (path.startsWith("/repos/acme/app/contents/")) {
      const f = path.slice("/repos/acme/app/contents/".length);
      if (f === ".github/workflows") return files[f] ? [{ name: "ci.yml" }] : { error: "404" };
      return files[f] ? { name: f } : { error: "404" };
    }
    if (path.includes("/check-runs")) return { check_runs: checkRuns.map((name) => ({ name })) };
    if (path.endsWith("/rulesets")) return [];
    return { error: "?" };
  },
}));

import { buildCiStarter, protectMain } from "./ci-starter.server";

describe("CI starter", () => {
  beforeEach(() => {
    files = {};
    checkRuns = [];
    posts.length = 0;
  });

  it("npm por default, actions fijadas por SHA con su tag, y runner de GitHub sin caja", async () => {
    const r = (await buildCiStarter("u", "acme/app")) as any;
    const yml = r.files[0].content as string;
    expect(yml).toContain("run: npm ci");
    expect(yml).toContain("actions/checkout@actions-checkout-v4-sha # v4");
    expect(yml).toContain("runs-on: ubuntu-latest");
    expect(yml).toContain("permissions:\n  contents: read");
    expect(r.files[1].content).toContain("/.github/ @acme");
  });

  it("pnpm por lockfile y la caja de CI del espacio cuando existe", async () => {
    files["pnpm-lock.yaml"] = true;
    const r = (await buildCiStarter("u", "acme/app", "ws-business")) as any;
    const yml = r.files[0].content as string;
    expect(yml).toContain("pnpm install --frozen-lockfile");
    expect(yml).toContain("pnpm/action-setup@");
    expect(yml).toContain("runs-on: [self-hosted, ws-business]");
  });

  it("proteger main exige SÓLO los checks que ya corren (nunca nombres supuestos)", async () => {
    checkRuns = ["verify", "security", "verify"];
    const r = await protectMain("u", "acme/app");
    expect(r).toMatchObject({ ok: true, checks: ["verify", "security"] });
    const rules = posts[0].body.rules.map((x: any) => x.type);
    expect(rules).toContain("pull_request");
    expect(rules).toContain("required_status_checks");
  });

  it("sin CI, la regla no exige checks (no bloquea todo PR)", async () => {
    await protectMain("u", "acme/app");
    expect(posts[0].body.rules.map((x: any) => x.type)).not.toContain("required_status_checks");
  });
});
