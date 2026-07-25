import { describe, expect, it } from "vitest";
import { makeArtifactHtmlTransform } from "./artifact-stream-doc";

describe("makeArtifactHtmlTransform — pintar desde el primer chunk", () => {
  it("abre el documento aunque el agente no haya escrito nada", () => {
    const out = makeArtifactHtmlTransform()("");
    expect(out).toContain("<body>");
    expect(out.indexOf("<body>")).toBeGreaterThan(0);
  });

  it("mete el <style> del agente DENTRO del body ya abierto (se aplica al vuelo)", () => {
    const t = makeArtifactHtmlTransform();
    t("");
    const out = t(`<!doctype html><html><head><style>:root{--color-primary:#8b5cf6}</style>`);
    expect(out).toContain("<style>:root{--color-primary:#8b5cf6}</style>");
    expect(out).not.toContain("<!doctype");
    expect(out).not.toContain("<head>");
    expect(out).not.toContain("<html");
  });

  it("traslada las clases del <body> del agente al body real", () => {
    const t = makeArtifactHtmlTransform();
    t("");
    const out = t(`</head><body class="bg-black text-white" style="margin:0"><h1>Hola</h1>`);
    expect(out).toContain('document.body.className="bg-black text-white"');
    expect(out).toContain('document.body.style.cssText="margin:0"');
    expect(out).toContain("<h1>Hola</h1>");
    expect(out).not.toContain("<body class");
  });

  it("no parte una etiqueta a la mitad entre chunks", () => {
    const t = makeArtifactHtmlTransform();
    t("");
    const a = t(`<div class="hero`);
    expect(a).not.toContain("hero"); // se queda en el buffer hasta que cierre
    const b = t(`">contenido</div>`);
    expect(b).toContain(`<div class="hero">contenido</div>`);
  });

  it("el resultado completo conserva todo el contenido del agente", () => {
    const src =
      `<!doctype html><html><head><script src="https://cdn.tailwindcss.com"></script>` +
      `<style>.x{color:red}</style></head><body class="p-4"><section>uno</section>` +
      `<section>dos</section></body></html>`;
    const t = makeArtifactHtmlTransform();
    let out = t("");
    for (let i = 0; i < src.length; i += 7) out += t(src.slice(i, i + 7));
    expect(out).toContain("cdn.tailwindcss.com");
    expect(out).toContain("<style>.x{color:red}</style>");
    expect(out).toContain("<section>uno</section>");
    expect(out).toContain("<section>dos</section>");
    expect(out).toContain('document.body.className="p-4"');
    // Una sola apertura de documento, sin envoltura duplicada del agente.
    expect(out.match(/<body>/g)?.length).toBe(1);
    expect(out).not.toContain("</html>");
  });
});
