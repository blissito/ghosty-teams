import { describe, it, expect } from "vitest";
import { bloquesDelTurno } from "./acp-client.server";

// El 2026-08-27, en el workspace `loop`, un usuario mandó a goose un CSV de 124KB y el
// agente le contestó dos veces que no le llegaba el contenido — acabó pidiéndole que
// copiara y pegara la hoja a mano. El archivo estaba guardado; lo que fallaba era el tramo
// Teams → agente ACP: `buildMediaParts` decidía inline-vs-uri por TAMAÑO y este cliente
// sabía mandar inline sólo IMÁGENES, así que todo archivo no-imagen de menos de 256KB caía
// al fallback. El chico fallaba y el grande funcionaba.
//
// Estos tests fijan las fronteras de esa matriz (bytes|uri × texto|imagen|otro), que es
// donde vive el bug.

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

const turno = (parts: any[], text = "revisa esto") =>
  ({ wsUrl: "ws://x", workspaceNs: "ns", sub: "u", text, parts, onUpdate: () => {} }) as any;

const textos = (bs: any[]) => bs.filter((b) => b.type === "text").map((b) => b.text).join("\n");

describe("adjuntos en un turno ACP", () => {
  it("EL BUG DEL CLIENTE: un CSV con bytes y sin uri llega COMPLETO, como texto", () => {
    const csv = "id,requisito,estado\nR19,Matriz,abierto\nR20,Otro,cerrado";
    const bs = bloquesDelTurno(
      turno([{ kind: "file", file: { name: "RM19.csv", mimeType: "text/csv", bytes: b64(csv) } }]),
      { puedeImagen: false }
    );
    const t = textos(bs);
    expect(t).toContain("R19,Matriz,abierto");
    expect(t).toContain("R20,Otro,cerrado");
    // La frase que el agente le trasladó al cliente no debe volver a aparecer.
    expect(t).not.toContain("pídeselo a quien escribe");
  });

  it("nunca trunca en silencio: lo dice y deja la uri para el resto", () => {
    const grande = "x".repeat(100 * 1024);
    const bs = bloquesDelTurno(
      turno([
        { kind: "file", file: { name: "g.csv", mimeType: "text/csv", bytes: b64(grande), uri: "https://s3/g" } },
      ]),
      { puedeImagen: false }
    );
    const t = textos(bs);
    expect(t).toContain("CORTADO");
    expect(t).toContain("https://s3/g");
    expect(t).toContain("No concluyas sobre lo que falta");
    expect(t.length).toBeLessThan(80 * 1024);
  });

  it("un texto que cabe entero NO se anuncia como cortado", () => {
    const bs = bloquesDelTurno(
      turno([{ kind: "file", file: { name: "a.txt", mimeType: "text/plain", bytes: b64("corto") } }]),
      { puedeImagen: false }
    );
    expect(textos(bs)).not.toContain("CORTADO");
  });

  it("un PDF chico con las dos vías va como resource_link, ya no se pierde", () => {
    const bs = bloquesDelTurno(
      turno([
        { kind: "file", file: { name: "a.pdf", mimeType: "application/pdf", bytes: b64("%PDF"), uri: "https://s3/a" } },
      ]),
      { puedeImagen: false }
    );
    expect(bs.some((b: any) => b.type === "resource_link" && b.uri === "https://s3/a")).toBe(true);
    expect(textos(bs)).not.toContain("pídeselo a quien escribe");
  });

  it("la imagen sigue yendo inline cuando el agente declara que la ve", () => {
    const bs = bloquesDelTurno(
      turno([{ kind: "file", file: { name: "f.png", mimeType: "image/png", bytes: "AAAA", uri: "https://s3/f" } }]),
      { puedeImagen: true }
    );
    expect(bs.some((b: any) => b.type === "image" && b.data === "AAAA")).toBe(true);
  });

  it("y si NO la ve, cae a resource_link en vez del mensaje de fallo", () => {
    const bs = bloquesDelTurno(
      turno([{ kind: "file", file: { name: "f.png", mimeType: "image/png", bytes: "AAAA", uri: "https://s3/f" } }]),
      { puedeImagen: false }
    );
    expect(bs.some((b: any) => b.type === "resource_link")).toBe(true);
    expect(bs.some((b: any) => b.type === "image")).toBe(false);
  });

  it("cuando de verdad no hay vía, NO se le pide al usuario que lo pegue a mano", () => {
    const bs = bloquesDelTurno(
      turno([{ kind: "file", file: { name: "x.bin", mimeType: "application/octet-stream" } }]),
      { puedeImagen: false }
    );
    const t = textos(bs);
    expect(t).toContain("la plataforma no pudo");
    expect(t).not.toContain("pídeselo a quien escribe");
    expect(t.toLowerCase()).toContain("no le pidas que lo pegue");
  });

  it("el mensaje de la persona va SIEMPRE al final, después del material", () => {
    const bs = bloquesDelTurno(
      turno([{ kind: "file", file: { name: "a.csv", mimeType: "text/csv", bytes: b64("a,b") } }], "resúmelo"),
      { puedeImagen: false }
    );
    expect((bs[bs.length - 1] as any).text).toContain("resúmelo");
  });
});
