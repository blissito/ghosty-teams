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

// ── La decisión viaja en el MENSAJE, no en el navegador que hizo clic ────────────
//
// Antes el estado vivía sólo en `localStorage`, así que para el resto del canal la tarjeta
// se quedaba pidiendo permiso para siempre — y por eso el servidor escribía además un
// «_Autorizado: X_» en prosa que salía duplicado justo debajo de la tarjeta.
describe("la decisión, en un segundo fence", () => {
  const pregunta = (askId = "a1") =>
    "```gt-perm\n" +
    JSON.stringify({
      askId,
      title: "¿Escribo celebracion.txt?",
      options: [
        { id: "allow", label: "Allow once", tone: "ok", kind: "allow_once" },
        { id: "deny", label: "Reject", tone: "danger", kind: "reject_once" },
      ],
    }) +
    "\n```";
  const decision = (o: Record<string, unknown>) => "```gt-perm\n" + JSON.stringify(o) + "\n```";

  it("sin decisión, la tarjeta sigue abierta", () => {
    const c = extractPermission(pregunta())!;
    expect(c.resolved).toBeUndefined();
    expect(c.denied).toBeUndefined();
    expect(c.options).toHaveLength(2);
  });

  it("el segundo fence resuelve al primero, conservando pregunta y opciones", () => {
    const c = extractPermission(`${pregunta()}\n\n${decision({ askId: "a1", resolved: "Allow once" })}`)!;
    expect(c.resolved).toBe("Allow once");
    expect(c.title).toBe("¿Escribo celebracion.txt?");
    expect(c.options).toHaveLength(2);
  });

  it("rechazado no es lo mismo que aún-no", () => {
    const c = extractPermission(`${pregunta()}\n\n${decision({ askId: "a1", denied: true })}`)!;
    expect(c.denied).toBe(true);
    expect(c.resolved).toBeUndefined();
  });

  it("una decisión de OTRO permiso no lo resuelve", () => {
    const c = extractPermission(`${pregunta("a1")}\n\n${decision({ askId: "otro", resolved: "Sí" })}`)!;
    expect(c.resolved).toBeUndefined();
  });

  it("el `kind` de ACP llega al cliente para poder traducir el botón", () => {
    const c = extractPermission(pregunta())!;
    // El label es del agente y viene en su idioma; el kind es del protocolo.
    expect(c.options.map((o) => o.kind)).toEqual(["allow_once", "reject_once"]);
  });

  it("se quitan TODOS los fences del cuerpo, no sólo el primero", () => {
    const body = `Voy a escribirlo.\n\n${pregunta()}\n\n${decision({ askId: "a1", resolved: "Allow once" })}\n\nListo.`;
    const limpio = stripPermission(body);
    expect(limpio).not.toContain("gt-perm");
    expect(limpio).not.toContain("askId");
    expect(limpio).toContain("Voy a escribirlo.");
    expect(limpio).toContain("Listo.");
  });
});
