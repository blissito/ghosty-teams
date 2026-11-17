import { describe, it, expect } from "vitest";
import { readablePage, readPreviewPage, safePreviewPath } from "./preview-read.server";

const KEY = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

describe("leer la preview sin ver la llave", () => {
  it("saca título y texto visible, sin scripts ni estilos", () => {
    const r = readablePage("<html><head><title> Agenda </title><style>x{}</style></head><body><script>var k='s'</script><h1>Hola</h1><p>Mesa&nbsp;3</p></body></html>");
    expect(r).toEqual({ title: "Agenda", text: "Agenda Hola Mesa 3", truncated: false });
  });

  it("sólo rutas de la misma preview", () => {
    expect(safePreviewPath("/pedidos?mesa=3")).toBe("/pedidos?mesa=3");
    for (const bad of ["//evil.test", "https://evil.test/", "pedidos", "/a b", "/a\\b", ""]) expect(safePreviewPath(bad)).toBeNull();
  });

  it("pide la página con la cookie gs_preview y la llave no vuelve en la respuesta", async () => {
    let seen: { url: string; cookie: string | undefined } | null = null;
    const hit = (async (url: string, init?: RequestInit) => {
      seen = { url, cookie: (init?.headers as Record<string, string>)?.cookie };
      return new Response("<title>Ok</title><body>bienvenida</body>", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await readPreviewPage(`https://sb-x-3000.preview.test/?k=${KEY}`, "/", hit);
    expect(seen).toEqual({ url: "https://sb-x-3000.preview.test/", cookie: `gs_preview=${KEY}` });
    expect(r).toMatchObject({ status: 200, title: "Ok" });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("sin preview lista o con ruta mala no hace petición", async () => {
    const hit = (async () => { throw new Error("no debe llamarse"); }) as unknown as typeof fetch;
    expect(await readPreviewPage(null, "/", hit)).toMatchObject({ error: expect.any(String) });
    expect(await readPreviewPage("https://x.test/?k=abcdef123456", "//evil", hit)).toMatchObject({ error: expect.any(String) });
  });
});
