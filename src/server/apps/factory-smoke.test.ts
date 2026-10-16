import { describe, it, expect, vi, afterEach } from "vitest";
import { actionSmoke, actionSmokeVerdict, reactRouterDataPath, smokeFailures } from "./factory-smoke.server";

describe("actionSmokeVerdict", () => {
  it("el #96: 400 por origen es fallo y cita el cuerpo", () => {
    const v = actionSmokeVerdict(400, "The request.url origin does not match origin header from a forwarded action request");
    expect(v.ok).toBe(false);
    expect(v.why).toContain("origin does not match");
  });
  it("403 y 5xx fallan; sin respuesta falla", () => {
    expect(actionSmokeVerdict(403, "").ok).toBe(false);
    expect(actionSmokeVerdict(502, "").ok).toBe(false);
    expect(actionSmokeVerdict(null, "").ok).toBe(false);
  });
  it("2xx, 3xx, 404/405 (sin acción) y 422 (validación) pasan el chequeo", () => {
    for (const s of [200, 204, 302, 404, 405, 422]) expect(actionSmokeVerdict(s, "").ok).toBe(true);
  });
});

describe("reactRouterDataPath", () => {
  it("raíz y rutas", () => {
    expect(reactRouterDataPath("/")).toBe("/_root.data");
    expect(reactRouterDataPath("/corte-de-pelo")).toBe("/corte-de-pelo.data");
    expect(reactRouterDataPath("/admin/usuarios/?x=1")).toBe("/admin/usuarios.data");
  });
});

describe("actionSmoke", () => {
  afterEach(() => vi.unstubAllGlobals());
  const RR_PAGE = "<script>window.__reactRouterContext = {}</script>";

  it("app de React Router: POST a la ruta de datos con Origin https y la cookie de la llave", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(init.method === "POST" ? "origin does not match" : RR_PAGE, { status: init.method === "POST" ? 400 : 200 });
    });
    const r = await actionSmoke("https://pr-55.preview.ghosty.page/?k=llave", []);
    const post = calls.find((c) => c.init.method === "POST")!;
    expect(post.url).toBe("https://pr-55.preview.ghosty.page/_root.data");
    expect((post.init.headers as Record<string, string>).origin).toBe("https://pr-55.preview.ghosty.page");
    expect((post.init.headers as Record<string, string>).cookie).toBe("gs_preview=llave");
    expect(r?.[0].ok).toBe(false);
    expect(smokeFailures(r)).toContain("POST /_root.data → 400");
  });

  it("app desconocida sin rutas declaradas: no manda POST a ciegas", async () => {
    const fetchSpy = vi.fn(async () => new Response("<html></html>", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    expect(await actionSmoke("https://x.preview.ghosty.page/", [])).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("ruta declarada en una app que no es de React Router: POST a la ruta tal cual", async () => {
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => new Response("", { status: init.method === "POST" ? 302 : 200 }));
    const r = await actionSmoke("https://x.preview.ghosty.page/", ["/login"]);
    expect(r).toEqual([{ path: "/login", method: "POST", status: 302, ok: true, why: "302: el envío pasó el chequeo de origen" }]);
  });
});
