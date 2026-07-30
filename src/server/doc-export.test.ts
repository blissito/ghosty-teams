import { describe, expect, it } from "vitest";
import { blocksToDocx, blocksToPrintHtml } from "./doc-export.server";
import { mdToBlocks } from "./doc-blocks.server";
import type { DocBlock } from "../lib/doc-blocks";

// El .docx es un ZIP: `word/document.xml` se puede leer y afirmar sobre él. Es la única
// forma honesta de fijar "las firmas bajan SIN bordes" — mirar el código del exportador no
// prueba nada sobre el archivo que recibe el usuario.
async function documentXml(buf: Buffer): Promise<string> {
  // jszip ya está en node_modules (lo usa `docx` por dentro), así que el test no añade deps.
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buf);
  const entry = zip.file("word/document.xml");
  expect(entry, "el .docx debe traer word/document.xml").toBeTruthy();
  return await entry!.async("string");
}

const CONTRATO = `# Contrato de prestación de servicios

## Primera. Objeto
El prestador se obliga a prestar los servicios descritos.

| Concepto | Monto |
| --- | --- |
| Anticipo | $10,000 |
| Finiquito | $15,000 |
`;

// Firmas lado a lado: dos columnas, dos párrafos cada una. Se arma con la forma COMPLETA
// que produce el editor (todo bloque trae `props`, `content` y `children`): el exportador
// los recorre sin defensas, y un fixture a medias falla por el fixture, no por el código.
const p = (text: string): DocBlock => ({
  type: "paragraph",
  props: {},
  content: [{ type: "text", text, styles: {} }],
  children: [],
});
const col = (...hijos: DocBlock[]): DocBlock => ({
  type: "column",
  props: { width: 1 },
  content: undefined,
  children: hijos,
});
const FIRMAS: DocBlock[] = [
  {
    type: "columnList",
    props: {},
    content: undefined,
    children: [col(p("Lic. Ana Ruiz"), p("Apoderada legal")), col(p("Ing. Beto Lara"), p("Representante"))],
  },
];

describe("export .docx desde bloques", () => {
  it("produce un ZIP válido de Word con el texto del documento", async () => {
    const blocks = await mdToBlocks(CONTRATO);
    const buf = await blocksToDocx(blocks, "Contrato");
    // PK: firma de ZIP. Un .docx que no empieza así no lo abre Word.
    expect(buf.subarray(0, 2).toString()).toBe("PK");
    const xml = await documentXml(buf);
    expect(xml).toContain("Contrato de prestación de servicios");
    expect(xml).toContain("Anticipo");
  });

  it("la tabla del contrato sobrevive como TABLA (es lo que el markdown deformaba)", async () => {
    const blocks = await mdToBlocks(CONTRATO);
    const xml = await documentXml(await blocksToDocx(blocks, "Contrato"));
    expect(xml).toContain("<w:tbl>");
    expect(xml).toContain("$15,000");
  });

  it("las FIRMAS en columnas bajan sin rejilla: bordes en nil", async () => {
    const xml = await documentXml(await blocksToDocx(FIRMAS, "Firmas"));
    expect(xml).toContain("Lic. Ana Ruiz");
    expect(xml).toContain("Ing. Beto Lara");
    // La maqueta es una tabla…
    expect(xml).toContain("<w:tbl>");
    // …y sus bordes van en "nil". Si algún día el exportador cambiara este default, este
    // test es el que avisa — es el requisito entero del documento con firmas.
    const bordes = xml.match(/w:val="nil"/g) ?? [];
    expect(bordes.length).toBeGreaterThanOrEqual(4);
  });

  it("una tabla normal SÍ conserva bordes (el borde es decisión por tabla)", async () => {
    const blocks = await mdToBlocks(CONTRATO);
    const xml = await documentXml(await blocksToDocx(blocks, "Contrato"));
    // `single` es el estilo de línea de la tabla de datos; convive con los `nil` de columnas.
    expect(xml).toContain('w:val="single"');
  });
});

describe("HTML de impresión (lo que imprime render-svc)", () => {
  it("sale autocontenido, con el contenido y sin adornos del editor", async () => {
    const blocks = await mdToBlocks(CONTRATO);
    const html = await blocksToPrintHtml(blocks, "Contrato");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("Contrato de prestación de servicios");
    expect(html).toContain("<style>");
    expect(html).toContain("@page");
    // Nada de la interfaz, ni la marca efímera del cambio quirúrgico.
    expect(html).not.toContain("bn-formatting-toolbar\"");
    expect(html).not.toContain("gt-cambio");
  });

  it("no pega a ningún host externo (ni CDN de fuentes ni proxy de imágenes)", async () => {
    const html = await blocksToPrintHtml(await mdToBlocks(CONTRATO), "Contrato");
    expect(html).not.toMatch(/https?:\/\/(?!localhost)/);
    expect(html).not.toContain("corsproxy");
  });
});
