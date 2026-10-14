import { describe, expect, it } from "vitest";

import { extractAlert, extractAsk, parseAskUserMd, stampFence } from "./ebdoc";

// La respuesta de una tarjeta vive en el MENSAJE (ver `server/card-state.ts`), no en el
// localStorage: otro dispositivo tiene que ver la pregunta cerrada.
describe("respuestas de tarjeta estampadas en el mensaje", () => {
  const ask = 'Antes:\n```gt-ask\n{"taskId":"t1","handle":"bot","groupId":"g","question":"¿Sigo?"}\n```\nDespués';
  const alert = '```gt-alert\n{"title":"Boom","actions":[{"label":"Arréglalo","send":"@fix arregla"}]}\n```\nBoom en prod';

  it("un mensaje viejo se lee como sin contestar", () => {
    expect(extractAsk(ask)?.answered).toBeUndefined();
    expect(extractAlert(alert)?.asked).toBeUndefined();
  });

  it("estampa sin romper lo que rodea al fence", () => {
    const a = stampFence(ask, "gt-ask", { answered: "Sí" })!;
    expect(extractAsk(a)).toMatchObject({ taskId: "t1", question: "¿Sigo?", answered: "Sí" });
    expect(a.startsWith("Antes:\n```gt-ask\n")).toBe(true);
    expect(a.endsWith("\n```\nDespués")).toBe(true);
    const b = stampFence(alert, "gt-alert", { asked: "@fix arregla" })!;
    expect(extractAlert(b)?.asked).toBe("@fix arregla");
    expect(b.endsWith("Boom en prod")).toBe(true);
  });

  it("no confunde gt-ask con gt-asks ni estampa un fence abierto o roto", () => {
    expect(stampFence('```gt-asks\n{"items":[]}\n```', "gt-ask", { answered: "x" })).toBeNull();
    expect(stampFence('```gt-ask\n{"taskId":"t1"', "gt-ask", { answered: "x" })).toBeNull();
    expect(stampFence("```gt-ask\n{roto}\n```", "gt-ask", { answered: "x" })).toBeNull();
  });

  it("ask-user: lee el md viejo (arreglo) y el contestado", () => {
    expect(parseAskUserMd('["A","B"]')).toEqual({ options: ["A", "B"] });
    expect(parseAskUserMd('{"options":["A","B"],"answered":"B"}')).toEqual({ options: ["A", "B"], answered: "B" });
    expect(parseAskUserMd(null)).toEqual({ options: [] });
    expect(parseAskUserMd("nope")).toEqual({ options: [] });
  });
});
