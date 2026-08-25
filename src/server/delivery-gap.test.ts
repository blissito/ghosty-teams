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

  // ── Falso positivo real, 2026-08-25 ──────────────────────────────────────────
  // El PRIMER mensaje que un cliente nuevo (Luis, DESCTI) vio del producto: una
  // respuesta de puro texto sobre alcances y límites, rematada con el aviso. El
  // culpable es «Aquí va», que en español introduce texto mucho más seguido que un
  // archivo. Un falso positivo aquí es peor que no avisar: inventa un hueco.
  it("🔴 no avisa cuando «aquí va» sólo introduce el texto que sigue", () => {
    const real =
      "Trabajo sobre **Claude Sonnet 5**, de Anthropic — dentro de Ghosty Teams como " +
      '"Ghosty". Aquí va el panorama honesto:\n\n**Alcances (lo que sí hago)**\n- ' +
      "Razonamiento, análisis y redacción larga.";
    expect(deliveryGapNotice(real, false)).toBe("");
  });

  it("tampoco sobre otros marcadores de discurso", () => {
    expect(deliveryGapNotice("Aquí está el resumen de lo que encontré: son tres puntos.", false)).toBe("");
    expect(deliveryGapNotice("Aquí tienes la comparación entre ambos modelos.", false)).toBe("");
    expect(deliveryGapNotice("Aquí va mi lectura del asunto.", false)).toBe("");
  });

  // …y lo que NO puede romperse al arreglar lo de arriba: cuando el anuncio ambiguo sí
  // nombra un archivo, el aviso tiene que seguir saliendo.
  it("sigue avisando cuando «aquí va» nombra un entregable", () => {
    expect(deliveryGapNotice("Aquí va la cotización en PDF:", false)).toContain("no lleva ninguno");
    expect(deliveryGapNotice("Aquí está de nuevo la etiqueta:", false)).toContain("no lleva ninguno");
    expect(deliveryGapNotice("Ya está lista la portada:", false)).toContain("no lleva ninguno");
  });
});
