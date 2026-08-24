import { describe, expect, it } from "vitest";
import { deliveryGapNotice } from "./delivery-gap";

// Los casos salen de la conversación REAL que lo destapó (business, DM 6, 2026-08-24).
describe("deliveryGapNotice", () => {
  it("caza el mensaje que promete y no lleva nada", () => {
    const real =
      '```gt-tools\n{"tools":[{"label":"Ejecuté un comando","detail":"label.html"}]}\n```\n\n' +
      "Aquí está de nuevo la etiqueta:\n\nSi sigues sin verla, dime en qué te aparece vacío.";
    expect(deliveryGapNotice(real, false)).toContain("no lleva ninguno");
  });

  it("se calla cuando la imagen SÍ va en el texto", () => {
    const real = "Va como imagen directa:\n\n![Etiqueta](https://t3.storage.dev/ghosty-teams/t3/x.png?X-Amz-Signature=ab)";
    expect(deliveryGapNotice(real, false)).toBe("");
  });

  // Un turno puede entregar por TARJETA sin una sola URL en el texto. Avisar ahí sería
  // decirle a la persona que falta algo que tiene delante.
  it("se calla cuando el entregable viaja como artefacto", () => {
    expect(deliveryGapNotice("Aquí está el documento:", true)).toBe("");
  });

  it("no confunde una URL de un bloque de herramientas con una entrega", () => {
    const solo_tools =
      '```gt-tools\n{"tools":[{"label":"Leí la página","detail":"https://t3.storage.dev/x.png"}]}\n```\n\nAquí te la dejo:';
    expect(deliveryGapNotice(solo_tools, false)).toContain("no lleva ninguno");
  });

  it("no se dispara sobre prosa normal", () => {
    expect(deliveryGapNotice("Ese link de Meet no lo puedo abrir ni unirme a llamadas.", false)).toBe("");
    expect(deliveryGapNotice("Va, la dejamos así, solo la etiqueta de Goku.", false)).toBe("");
  });
});
