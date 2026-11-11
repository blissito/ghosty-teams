import { describe, expect, it, vi } from "vitest";

vi.mock("./server/tenant.server", () => ({ currentNamespace: async () => "t", isPersonalNs: () => false }));
vi.mock("./server/env-check.server", () => ({ assertEnv: () => {} }));
vi.mock("./server/shutdown.server", () => ({ armarProteccionDeProceso: () => {} }));
vi.mock("./server/known-tenants.server", () => ({ warmKnownTenants: () => {} }));
const { retryOnEviction } = await import("./dbq.server");

const notExist = () => new Response(JSON.stringify({ error: "Namespace `u_x` doesn't exist" }), { status: 404 });

describe("retryOnEviction (404 falso de sqld al descargar una base)", () => {
  it("reintenta y recupera", async () => {
    const f = vi.fn().mockResolvedValueOnce(notExist()).mockResolvedValueOnce(new Response("{}"));
    expect((await retryOnEviction(f)).status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("no reintenta otros errores", async () => {
    const f = vi.fn().mockResolvedValue(new Response("bad", { status: 400 }));
    expect((await retryOnEviction(f)).status).toBe(400);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("se rinde tras 3 reintentos", async () => {
    const f = vi.fn().mockImplementation(async () => notExist());
    expect((await retryOnEviction(f)).status).toBe(404);
    expect(f).toHaveBeenCalledTimes(4);
  });
});
