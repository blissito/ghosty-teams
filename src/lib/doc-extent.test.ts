import { describe, it, expect } from "vitest";
import { measureExtent, extentLine, WORDS_PER_PAGE } from "./doc-extent";

const words = (n: number) => Array.from({ length: n }, (_, i) => `palabra${i}`).join(" ");

describe("measureExtent", () => {
  it("cuenta palabras de prosa y las convierte a cuartillas", () => {
    expect(measureExtent(words(500))).toEqual({ words: 500, pages: 2 });
  });

  it("un documento vacío no miente con 0.0 cuartillas: extentLine se calla", () => {
    expect(measureExtent("").words).toBe(0);
    expect(extentLine("")).toBe("");
    expect(extentLine("   \n\n  ")).toBe("");
  });

  it("no cuenta bloques de código ni el CSS horneado", () => {
    const md = `${words(250)}\n\n\`\`\`js\nconst a = 1; const b = 2; const c = 3;\n\`\`\``;
    expect(measureExtent(md).words).toBe(250);
    expect(measureExtent(`${words(10)}<style>a{color:red;font-size:12px}</style>`).words).toBe(10);
  });

  it("de un enlace cuenta el texto visible, no la URL", () => {
    // "ver" + "el" + "informe" = 3; la URL no se lee en la hoja.
    expect(measureExtent("ver [el informe](https://ejemplo.com/muy/larga/ruta.pdf)").words).toBe(3);
  });

  it("una imagen no aporta palabras", () => {
    expect(measureExtent(`![una foto del inmueble](https://x.com/a.png) ${words(5)}`).words).toBe(5);
  });

  it("el marcado de markdown no infla la cuenta", () => {
    expect(measureExtent("### Título\n\n**PRIMERA.** El arrendatario").words).toBe(4);
  });

  it("el caso real: 4 cuartillas son ~1000 palabras", () => {
    expect(measureExtent(words(4 * WORDS_PER_PAGE)).pages).toBe(4);
    // Lo que entregó el agente al "ajustar a 4" quedó muy por debajo — hoy se ve.
    expect(measureExtent(words(600)).pages).toBe(2.4);
  });

  it("la línea inyectada trae el conteo y se declara real", () => {
    const line = extentLine(words(1000));
    expect(line).toContain("1000 palabras");
    expect(line).toContain("4 cuartillas");
    expect(line).toContain("conteo real");
  });
});
