import { describe, it, expect, vi, beforeEach } from "vitest";

let responses: Record<string, unknown> = {};
vi.mock("../connectors/github.server", () => ({
  githubApi: async (_sub: string, path: string) => (path in responses ? responses[path] : { error: "404" }),
}));

import { commitPreview, isAppUrl, isProduction, providerOf, repoHasPreviews } from "./preview.server";

const D = "/repos/acme/app/deployments";
let n = 0;
const sha = () => `sha${++n}`;

describe("previews por PR", () => {
  beforeEach(() => {
    responses = {};
  });

  it("producción y paneles del proveedor NO son preview", () => {
    expect(isProduction({ production_environment: true })).toBe(true);
    expect(isProduction({ environment: "Production" })).toBe(true);
    expect(isProduction({ environment: "Preview" })).toBe(false);
    expect(isAppUrl("https://vercel.com/acme/app/abc")).toBe(false);
    expect(isAppUrl("https://app-git-feat-acme.vercel.app")).toBe(true);
    expect(providerOf("https://deploy-preview-3--acme.netlify.app")).toBe("Netlify");
  });

  it("deployment de preview lista: su environment_url", async () => {
    const s = sha();
    responses[`${D}?sha=${s}&per_page=10`] = [
      { id: 1, environment: "Production", production_environment: true },
      { id: 2, environment: "Preview", creator: { login: "vercel[bot]" } },
    ];
    responses[`${D}/2/statuses?per_page=1`] = [{ state: "success", environment_url: "https://app-git-x.vercel.app", target_url: "https://vercel.com/acme/app/x" }];
    expect(await commitPreview("u", "acme/app", s)).toEqual({ state: "ready", url: "https://app-git-x.vercel.app", provider: "Vercel", sha: s });
  });

  it("en camino y luego lista: lo pendiente no se queda cacheado para siempre", async () => {
    const s = sha();
    responses[`${D}?sha=${s}&per_page=10`] = [{ id: 3, environment: "Preview" }];
    responses[`${D}/3/statuses?per_page=1`] = [{ state: "in_progress" }];
    expect((await commitPreview("u", "acme/app", s)).state).toBe("pending");
    vi.useFakeTimers({ now: Date.now() + 60_000 });
    responses[`${D}/3/statuses?per_page=1`] = [{ state: "success", environment_url: "https://pr-3.fly.dev" }];
    const p = await commitPreview("u", "acme/app", s);
    vi.useRealTimers();
    expect(p.state).toBe("ready");
    expect(p.provider).toBe("Fly");
  });

  it("Netlify por commit status; el status más nuevo de cada context manda", async () => {
    const s = sha();
    responses[`/repos/acme/app/commits/${s}/statuses?per_page=50`] = [
      { context: "netlify/acme/deploy-preview", state: "success", target_url: "https://deploy-preview-7--acme.netlify.app" },
      { context: "netlify/acme/deploy-preview", state: "pending", target_url: "https://app.netlify.com/sites/acme/deploys/1" },
      { context: "ci/verify", state: "success", target_url: "https://github.com/acme/app/actions/runs/1" },
    ];
    const p = await commitPreview("u", "acme/app", s);
    expect(p).toMatchObject({ state: "ready", url: "https://deploy-preview-7--acme.netlify.app", provider: "Netlify" });
  });

  it("preview fallida y repo sin previews", async () => {
    const s = sha();
    responses[`${D}?sha=${s}&per_page=10`] = [{ id: 4, environment: "Preview" }];
    responses[`${D}/4/statuses?per_page=1`] = [{ state: "failure" }];
    expect((await commitPreview("u", "acme/app", s)).state).toBe("failed");
    expect((await commitPreview("u", "acme/app", sha())).state).toBe("none");
  });

  it("repoHasPreviews: deployments que no son de producción", async () => {
    responses[`${D}?per_page=30`] = [{ environment: "production" }];
    expect(await repoHasPreviews("u", "acme/app", "main")).toBe(false);
    responses[`${D}?per_page=30`] = [{ environment: "production" }, { environment: "pr-12" }];
    expect(await repoHasPreviews("u", "acme/app", "main")).toBe(true);
  });
});
