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

  it("repoHasPreviews: un despliegue reciente que no es de producción, con status success y URL", async () => {
    const recent = new Date().toISOString();
    responses[`${D}?per_page=30`] = [{ id: 10, environment: "production", created_at: recent }];
    expect(await repoHasPreviews("u", "acme/app", "main")).toBe(false);
    responses[`${D}?per_page=30`] = [{ id: 10, environment: "production", created_at: recent }, { id: 12, environment: "pr-12", created_at: recent }];
    responses[`${D}/12/statuses?per_page=1`] = [{ state: "success", environment_url: "https://pr-12.fly.dev" }];
    expect(await repoHasPreviews("u", "acme/app", "main")).toBe(true);
  });

  // easybits (20-oct): un despliegue `preview-157` de 2025 (github-actions, ya `inactive`) hacía creer
  // que el hosting publicaba previews; nunca se le pidió la caja a gs y cinco previews se quedaron
  // `pending` para siempre. Fixture tal como lo devuelve GitHub.
  it("repoHasPreviews: el preview-157 viejo de easybits NO cuenta (easybits, 20-oct)", async () => {
    responses["/repos/blissito/easybits/deployments?per_page=30"] = [
      {
        id: 2732601918,
        environment: "preview-157",
        created_at: "2025-07-12T15:49:29Z",
        creator: { login: "github-actions[bot]" },
        description: "Preview deployment for PR #157",
        production_environment: false,
        transient_environment: true,
      },
    ];
    responses["/repos/blissito/easybits/deployments/2732601918/statuses?per_page=1"] = [{ state: "inactive", environment_url: "", created_at: "2025-07-12T20:08:57Z" }];
    responses["/repos/blissito/easybits/commits/main/statuses?per_page=30"] = [];
    expect(await repoHasPreviews("u", "blissito/easybits", "main")).toBe(false);
  });

  it("repoHasPreviews: reciente pero inactivo o sin URL tampoco cuenta", async () => {
    const recent = new Date().toISOString();
    responses[`${D}?per_page=30`] = [{ id: 20, environment: "preview-3", created_at: recent }];
    responses[`${D}/20/statuses?per_page=1`] = [{ state: "inactive", environment_url: "https://pr-3.fly.dev" }];
    expect(await repoHasPreviews("u", "acme/app", "main")).toBe(false);
    responses[`${D}/20/statuses?per_page=1`] = [{ state: "success", environment_url: "" }];
    expect(await repoHasPreviews("u", "acme/app", "main")).toBe(false);
  });

  it("repoHasPreviews: los despliegues de la propia Ghosty (publishPreviewDeployment) no cuentan", async () => {
    const recent = new Date().toISOString();
    responses[`${D}?per_page=30`] = [
      { id: 30, environment: "preview", created_at: recent, description: "Preview de Ghosty", creator: { login: "bliss" } },
      { id: 31, environment: "preview", created_at: recent, creator: { login: "ghosty-studio[bot]" } },
    ];
    responses[`${D}/30/statuses?per_page=1`] = [{ state: "success", environment_url: "https://pr-9.preview.ghosty.studio" }];
    responses[`${D}/31/statuses?per_page=1`] = [{ state: "success", environment_url: "https://pr-9.preview.ghosty.studio" }];
    expect(await repoHasPreviews("u", "acme/app", "main")).toBe(false);
  });
});
