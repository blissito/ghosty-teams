// La tarjeta de permiso ACP y —lo que motivó separarla— que su JSON no se pinte crudo.
import { describe, expect, it } from "vitest";

import { bubbleWithoutEbDoc, extractPermission, stripPermission } from "./ebdoc";

const fence = (o: unknown) => "```gt-perm\n" + JSON.stringify(o) + "\n```";
const bueno = {
  askId: "perm-1",
  title: "Ejecutar `rm -rf /data/work/tmp`",
  options: [
    { id: "allow", label: "Permitir", tone: "ok" },
    { id: "reject", label: "Rechazar", tone: "danger" },
  ],
};

describe("extractPermission", () => {
  it("lee un fence completo", () => {
    const p = extractPermission(`Voy a limpiar.\n\n${fence(bueno)}\n`);
    expect(p).toEqual(bueno);
  });

  it("un fence a medio llegar NO pinta botones", () => {
    // Autorizar con opciones incompletas es peor que esperar a que cierre.
    expect(extractPermission('```gt-perm\n{"askId":"p","title":"algo"')).toBeNull();
  });

  it("sin askId no hay a quién desbloquear", () => {
    expect(extractPermission(fence({ ...bueno, askId: "" }))).toBeNull();
  });

  it("⚠️ sin opciones NO se inventan Sí/No", () => {
    // Al revés que la pregunta de A2A: aquí inventar botones sería ofrecer una autorización
    // que el agente nunca ofreció, y el optionId no significaría nada del otro lado.
    expect(extractPermission(fence({ ...bueno, options: [] }))).toBeNull();
  });

  it("descarta opciones a medias y corta en 4", () => {
    const p = extractPermission(
      fence({ ...bueno, options: [{ id: "a", label: "A" }, { id: "b" }, { label: "C" }] }),
    );
    expect(p?.options).toEqual([{ id: "a", label: "A", tone: undefined }]);
  });

  it("stripPermission deja la prosa y quita el bloque", () => {
    // Los saltos que rodeaban al fence se quedan, igual que en `bodyWithoutAsk`: Markdown los
    // colapsa al pintar, y tocarlos aquí sería divergir de la hermana sin motivo.
    const fuera = stripPermission(`Antes\n\n${fence(bueno)}\n\nDespués`);
    expect(fuera).not.toContain("gt-perm");
    expect(fuera.replace(/\n+/g, "\n")).toBe("Antes\nDespués");
  });
});

describe("el JSON no se pinta crudo", () => {
  // Ésta es la regresión que motivó todo: `bodyWithoutAsk` existía y NO la llamaba nadie, así
  // que el JSON de cada tarjeta de A2A salía como recuadro de código encima de la tarjeta.
  it("bubbleWithoutEbDoc corta el fence de permiso", () => {
    const b = bubbleWithoutEbDoc(`Voy a limpiar.\n\n${fence(bueno)}\n`);
    expect(b).not.toContain("gt-perm");
    expect(b).not.toContain("askId");
    expect(b).toContain("Voy a limpiar.");
  });

  it("y también el de pregunta, que era el bug", () => {
    const ask =
      "```gt-ask\n" +
      JSON.stringify({ taskId: "t1", handle: "noob", groupId: "g1", question: "¿Sigo?" }) +
      "\n```";
    const b = bubbleWithoutEbDoc(`Terminé el análisis.\n\n${ask}\n`);
    expect(b).not.toContain("gt-ask");
    expect(b).not.toContain("taskId");
    expect(b).toContain("Terminé el análisis.");
  });

  it("al GUARDAR se conservan: el cliente saca la tarjeta del propio body", () => {
    // Misma regla que el resto de los fences (keepStatus). Si se cortaran al persistir, volver
    // al hilo no enseñaría la tarjeta y no habría de dónde recuperarla.
    const body = `Voy a limpiar.\n\n${fence(bueno)}\n`;
    expect(bubbleWithoutEbDoc(body, undefined, { keepStatus: true })).toContain("gt-perm");
  });
});
