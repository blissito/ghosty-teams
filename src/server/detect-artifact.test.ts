import { describe, expect, it } from "vitest";
import { detectArtifact } from "./easybits-documents.server";

// El caso que rompió en descti el 2026-09-08 (gc_artifacts id 37): la URL de la card salía
// de DENTRO del bloque de contabilidad del turno, donde las URLs vienen RECORTADAS.
const TOOLS = [
  "```gt-tools",
  JSON.stringify({
    tools: [
      { label: "read https://t3.storage.dev...…", status: "error" },
      { label: "read", status: "ok" },
    ],
  }),
  "```",
].join("\n");

describe("detectArtifact", () => {
  it("no saca la URL del bloque gt-tools", () => {
    expect(detectArtifact(`${TOOLS}\n\nListo el rediseño.`)).toBeNull();
  });

  it("no saca la URL del bloque gt-steps", () => {
    const steps = '```gt-steps\n{"steps":["subí https://t3.storage.dev...…"]}\n```';
    expect(detectArtifact(`${steps}\n\nYa quedó.`)).toBeNull();
  });

  it("descarta una URL recortada aunque esté en la prosa", () => {
    expect(detectArtifact("la subí a https://t3.storage.dev/x/y...… y ahí está")).toBeNull();
  });

  it("no se traga las comillas ni las comas que siguen a la URL", () => {
    const found = detectArtifact('{"url":"https://t3.storage.dev/b/poster.png","status":"ok"}');
    expect(found).toMatchObject({ type: "file", url: "https://t3.storage.dev/b/poster.png" });
  });

  it("sigue detectando el archivo que el agente entregó en la prosa", () => {
    const reply = `${TOOLS}\n\nAhí va: ![póster](https://t3.storage.dev/b/poster.png)`;
    expect(detectArtifact(reply)).toMatchObject({
      type: "file",
      kind: "image",
      url: "https://t3.storage.dev/b/poster.png",
    });
  });

  it("el alt de una imagen NO da título (es el nombre del archivo local del agente)", () => {
    const found = detectArtifact("![index](https://t3.storage.dev/b/poster.png)");
    expect(found).toMatchObject({ type: "file" });
    expect((found as { title?: string }).title).toBeUndefined();
  });

  it("el label de un link de texto sí da título", () => {
    expect(detectArtifact("[el póster ochentero](https://t3.storage.dev/b/p.png)")).toMatchObject({
      title: "el póster ochentero",
    });
  });
});
