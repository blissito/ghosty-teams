import { describe, it, expect } from "vitest";

import { bubbleWithoutEbDoc, extractFx, stripFx } from "./ebdoc";

const fence = (json: string) => "```gt-fx\n" + json + "\n```";

describe("extractFx", () => {
  it("saca el efecto", () => {
    expect(extractFx(`¡Quedó! ${fence('{"fx":"confetti"}')}`)).toEqual({ fx: "confetti" });
  });

  it("acepta mayúsculas y espacios: el modelo escribe como quiere", () => {
    expect(extractFx(fence('{"fx":" Hearts "}'))).toEqual({ fx: "hearts" });
  });

  // La razón de ser de la lista cerrada. Un nombre libre acaba siendo un modelo decidiendo
  // qué se pinta en la pantalla de todo el room.
  it("un efecto inventado NO cae a uno por defecto: se ignora", () => {
    expect(extractFx(fence('{"fx":"fireworks"}'))).toBeNull();
    expect(extractFx(fence('{"fx":"<script>alert(1)</script>"}'))).toBeNull();
  });

  it("fence a medio streamear: no dispara media fiesta", () => {
    expect(extractFx('```gt-fx\n{"fx":"confetti"}')).toBeNull();
  });

  it("JSON roto no revienta", () => {
    expect(extractFx("```gt-fx\n{fx:confetti\n```")).toBeNull();
  });
});

describe("stripFx", () => {
  it("conserva lo de antes y lo de después", () => {
    const body = `Terminé el reporte.\n\n${fence('{"fx":"confetti"}')}\n\n¿Lo reviso?`;
    expect(stripFx(body)).toBe("Terminé el reporte.\n\n¿Lo reviso?");
  });

  // Un fence sin strip sale como recuadro de código en la burbuja PARA SIEMPRE, que es lo
  // contrario de un efecto efímero. Es el bug que ya se pagó con gt-task y con gt-ask.
  it("el JSON no llega al bubble", () => {
    const body = `¡Felicidades! ${fence('{"fx":"hearts"}')}`;
    const bubble = bubbleWithoutEbDoc(body);
    expect(bubble).not.toContain("gt-fx");
    expect(bubble).not.toContain('"fx"');
    expect(bubble).toContain("¡Felicidades!");
  });

  // Guardar es lo contrario de pintar: el cuerpo se re-parsea en cada render, así que el
  // fence tiene que sobrevivir en la fila o el efecto no existiría para quien lo recibe.
  it("con keepStatus el fence SOBREVIVE", () => {
    const body = `listo ${fence('{"fx":"snow"}')}`;
    expect(bubbleWithoutEbDoc(body, undefined, { keepStatus: true })).toContain("gt-fx");
  });
});
