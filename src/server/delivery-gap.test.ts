import { describe, expect, it } from "vitest";
import { deliveryGapNotice, hayHuecoPrevio, GAP_MARK } from "./delivery-gap";

// Los casos salen de la conversación REAL que lo destapó (business, DM 6, 2026-08-24).
describe("deliveryGapNotice", () => {
  it("caza el mensaje que promete y no lleva nada", () => {
    const real =
      '```gt-tools\n{"tools":[{"label":"Ejecuté un comando","detail":"label.html"}]}\n```\n\n' +
      "Aquí está de nuevo la etiqueta:\n\nSi sigues sin verla, dime en qué te aparece vacío.";
    expect(deliveryGapNotice(real, false)).toContain(GAP_MARK);
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
    expect(deliveryGapNotice(solo_tools, false)).toContain(GAP_MARK);
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
    expect(deliveryGapNotice("Aquí va la cotización en PDF:", false)).toContain(GAP_MARK);
    expect(deliveryGapNotice("Aquí está de nuevo la etiqueta:", false)).toContain(GAP_MARK);
    expect(deliveryGapNotice("Ya está lista la portada:", false)).toContain(GAP_MARK);
  });
});

// ── El incidente del 2026-08-31 (descti, DM de rodrigorafael.gogo) ──────────────────
// Cuatro mensajes prometieron un .docx sin entregarlo y el detector cazó UNO. Los otros
// tres decían «Ahí», no «Aquí». Cuerpos reales, recortados.
describe("«ahí» cuenta tanto como «aquí»", () => {
  it("🔴 caza «Ahí tienes el .docx» (antes se le escapaba)", () => {
    const real = "Perdón, confundí el documento. Ahí tienes el .docx editable del Dictamen de Excepción.";
    expect(deliveryGapNotice(real, false)).toContain(GAP_MARK);
  });

  it("🔴 caza «Ahí va, en la tarjeta de arriba» — la tarjeta no existía", () => {
    const real = "Ahí va, en la tarjeta de arriba. Si no te aparece descargable, dime y lo intento por otra vía.";
    expect(deliveryGapNotice(real, false)).toContain(GAP_MARK);
  });

  // Lo que NO puede romperse al ampliar el patrón: la red de AMBIGUOS sigue viva, o
  // volvemos al falso positivo de 2026-08-25 con «ahí» en vez de «aquí».
  it("sigue callado cuando «ahí va» sólo introduce texto", () => {
    expect(deliveryGapNotice("Ahí va el panorama honesto de lo que puedo hacer:", false)).toBe("");
    expect(deliveryGapNotice("Ahí está mi lectura del asunto.", false)).toBe("");
  });
});

describe("el aviso que lee la PERSONA", () => {
  // El fallo caro del 2026-08-31 no fue detectar de menos: fue que el aviso le hablaba al
  // AGENTE en la cara del usuario, y el usuario copió el fragmento y lo mandó de vuelta.
  // Esta propiedad es la que impide que vuelva a pasar.
  it("🔴 no le da a la persona nada que copiar", () => {
    const aviso = deliveryGapNotice("Aquí va la cotización en PDF:", false);
    expect(aviso).not.toMatch(/`|\/tmp|publish\(|eb-file|https?:|\.mjs/);
  });

  it("dice qué pasa después, no qué tiene que hacer ella", () => {
    expect(deliveryGapNotice("Aquí va la cotización en PDF:", false)).toContain("agente");
  });
});

describe("el re-aviso AL AGENTE del turno siguiente", () => {
  const conHueco = deliveryGapNotice("Aquí va la cotización en PDF:", false);

  it("la marca del aviso y la que busca el turno siguiente son la MISMA", () => {
    // Si alguien reescribe el copy y se lleva la marca por delante, el hint deja de
    // dispararse sin que nada falle. Esto lo convierte en un test rojo.
    expect(conHueco).toContain(GAP_MARK);
    expect(hayHuecoPrevio(`Ahí va, en la tarjeta de arriba.\n\n${conHueco}`)).toBe(true);
  });

  it("se calla cuando el mensaje anterior no tiene hueco", () => {
    expect(hayHuecoPrevio("Aquí tienes el archivo: https://t3.storage.dev/x.docx")).toBe(false);
    expect(hayHuecoPrevio("")).toBe(false);
    expect(hayHuecoPrevio(null)).toBe(false);
    expect(hayHuecoPrevio(undefined)).toBe(false);
  });

  // El lazo entero: en cuanto un turno SÍ entrega, `deliveryGapNotice` no estampa la marca,
  // el mensaje nuevo no la lleva y el hint desaparece solo. Sin estado que limpiar.
  it("🔴 se apaga solo cuando el turno siguiente sí entrega", () => {
    const entregado = "Ahora sí:\n\n```eb-file\n{\"url\":\"https://t3.storage.dev/x.docx\"}\n```";
    expect(deliveryGapNotice(entregado, false)).toBe("");
    expect(hayHuecoPrevio(entregado)).toBe(false);
  });
});
