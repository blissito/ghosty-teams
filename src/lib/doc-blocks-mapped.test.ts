import { describe, expect, it } from "vitest";
import { blockText, blockTextMapped, rangoCrudo, reemplazarEnBloque, type DocBlock } from "./doc-blocks";

// El mapa es lo que permite señalar una falta y sustituirla sin tocar el resto del párrafo.
// Si se desincroniza, el fallo NO se ve al resaltar: se ve al aplicar, corrompiendo texto
// de alguien. De ahí que estos tests sean más quisquillosos de lo normal.

const parrafo = (runs: { text: string; styles?: Record<string, boolean> }[]): DocBlock => ({
  id: "b1",
  type: "paragraph",
  content: runs.map((r) => ({ type: "text", text: r.text, styles: r.styles ?? {} })),
});

/** Lo que el corrector diría de `palabra` dentro del texto del bloque. */
function buscar(b: DocBlock, palabra: string) {
  const mapa = blockTextMapped(b);
  const offset = mapa.texto.indexOf(palabra);
  return { mapa, offset, length: palabra.length };
}

describe("blockTextMapped", () => {
  it("el texto es EXACTAMENTE el de blockText (son la misma función)", () => {
    for (const b of [
      parrafo([{ text: "Hola mundo" }]),
      parrafo([{ text: "El " }, { text: "arrendatario", styles: { bold: true } }, { text: " pagará" }]),
      parrafo([{ text: "  espacios   de   sobra  " }]),
      { id: "x", type: "paragraph", content: [] } as DocBlock,
    ]) {
      expect(blockTextMapped(b).texto).toBe(blockText(b));
    }
  });

  it("cada carácter apunta a su origen en el texto crudo", () => {
    const b = parrafo([{ text: "El " }, { text: "artifice", styles: { bold: true } }, { text: " fabrica" }]);
    const { mapa, offset, length } = buscar(b, "artifice");
    const r = rangoCrudo(mapa, offset, length);
    expect(r).not.toBeNull();
    expect(r!.hasta - r!.desde).toBe(length);
    // Cae dentro de UN run (el de la negrita) → se puede reemplazar sin perder formato.
    expect(r!.unSoloRun).toBe(true);
  });

  it("un rango que cruza dos runs se puede señalar pero NO aplicar", () => {
    // "arren" normal + "da" en negrita + "tario" normal — la palabra completa cruza tres.
    const b = parrafo([{ text: "arren" }, { text: "da", styles: { bold: true } }, { text: "tario" }]);
    const { mapa, offset, length } = buscar(b, "arrendatario");
    const r = rangoCrudo(mapa, offset, length);
    expect(r).not.toBeNull();
    expect(r!.unSoloRun).toBe(false);
  });

  it("los espacios colapsados no son direccionables", () => {
    const b = parrafo([{ text: "uno    dos" }]);
    expect(blockText(b)).toBe("uno dos");
    const mapa = blockTextMapped(b);
    // El rango "uno dos" incluye el espacio colapsado: su longitud cruda es mayor.
    expect(rangoCrudo(mapa, 0, 7)).toBeNull();
    // Pero cada palabra suelta sí.
    expect(rangoCrudo(mapa, 0, 3)).not.toBeNull();
    expect(rangoCrudo(mapa, 4, 3)).not.toBeNull();
  });

  it("un rango que cruza celdas de una tabla NO es direccionable", () => {
    // El separador entre celdas lo inventa el recorrido: no existe en el documento.
    const b: DocBlock = {
      id: "t1",
      type: "table",
      content: {
        type: "tableContent",
        rows: [
          { cells: [[{ type: "text", text: "Concepto", styles: {} }], [{ type: "text", text: "Monto", styles: {} }]] },
        ],
      } as never,
    };
    expect(blockText(b)).toBe("Concepto Monto");
    const mapa = blockTextMapped(b);
    // Dentro de una celda, bien.
    expect(rangoCrudo(mapa, 0, 8)).not.toBeNull();
    // Cruzando el separador inventado, no.
    expect(rangoCrudo(mapa, 0, 14)).toBeNull();
  });

  it("el trim del principio no descoloca los offsets", () => {
    const b = parrafo([{ text: "   Dedalo no es un dios." }]);
    const { mapa, offset, length } = buscar(b, "Dedalo");
    expect(offset).toBe(0); // ya viene trimeado
    const r = rangoCrudo(mapa, offset, length);
    expect(r).not.toBeNull();
    // En el CRUDO, "Dedalo" empieza en 3 (después de los tres espacios).
    expect(r!.desde).toBe(3);
  });

  it("atraviesa links sin perder el rastro", () => {
    const b: DocBlock = {
      id: "l1",
      type: "paragraph",
      content: [
        { type: "text", text: "Ver ", styles: {} },
        { type: "link", href: "https://x.mx", content: [{ type: "text", text: "el acuerdo", styles: {} }] },
        { type: "text", text: " firmado", styles: {} },
      ] as never,
    };
    expect(blockText(b)).toBe("Ver el acuerdo firmado");
    const { mapa, offset, length } = buscar(b, "acuerdo");
    const r = rangoCrudo(mapa, offset, length);
    expect(r).not.toBeNull();
    expect(r!.unSoloRun).toBe(true);
  });

  it("un bloque vacío no rompe nada", () => {
    const mapa = blockTextMapped({ id: "v", type: "paragraph", content: [] });
    expect(mapa.texto).toBe("");
    expect(rangoCrudo(mapa, 0, 1)).toBeNull();
  });
});

describe("reemplazarEnBloque", () => {
  it("corrige la palabra y conserva el formato del resto", () => {
    const b = parrafo([
      { text: "El " },
      { text: "artifice", styles: { bold: true } },
      { text: " fabrica una prision" },
    ]);
    const { mapa, offset, length } = buscar(b, "artifice");
    const r = rangoCrudo(mapa, offset, length)!;
    const nuevo = reemplazarEnBloque(b, r.desde, r.hasta, "artífice");
    expect(blockText(nuevo)).toBe("El artífice fabrica una prision");
    // El run corregido conserva su negrita; los demás, intactos.
    const runs = nuevo.content as { text: string; styles: Record<string, boolean> }[];
    expect(runs[1]).toEqual({ type: "text", text: "artífice", styles: { bold: true } });
    expect(runs[0].text).toBe("El ");
    expect(runs[2].text).toBe(" fabrica una prision");
  });

  it("no cambia el id del bloque", () => {
    const b = parrafo([{ text: "una prueva" }]);
    const { mapa, offset, length } = buscar(b, "prueva");
    const r = rangoCrudo(mapa, offset, length)!;
    expect(reemplazarEnBloque(b, r.desde, r.hasta, "prueba").id).toBe(b.id);
  });

  it("corrige dentro de un link sin romperlo", () => {
    const b: DocBlock = {
      id: "l1",
      type: "paragraph",
      content: [
        { type: "text", text: "Ver ", styles: {} },
        { type: "link", href: "https://x.mx", content: [{ type: "text", text: "el acuerdo firmadooo", styles: {} }] },
      ] as never,
    };
    const { mapa, offset, length } = buscar(b, "firmadooo");
    const r = rangoCrudo(mapa, offset, length)!;
    const nuevo = reemplazarEnBloque(b, r.desde, r.hasta, "firmado");
    expect(blockText(nuevo)).toBe("Ver el acuerdo firmado");
    const link = (nuevo.content as { type: string; href?: string }[])[1];
    expect(link.type).toBe("link");
    expect(link.href).toBe("https://x.mx");
  });

  it("una corrección más larga o más corta no descoloca el resto", () => {
    const b = parrafo([{ text: "esto es aver si funciona bien" }]);
    const { mapa, offset, length } = buscar(b, "aver");
    const r = rangoCrudo(mapa, offset, length)!;
    expect(blockText(reemplazarEnBloque(b, r.desde, r.hasta, "a ver"))).toBe("esto es a ver si funciona bien");
    expect(blockText(reemplazarEnBloque(b, r.desde, r.hasta, "x"))).toBe("esto es x si funciona bien");
  });
});
