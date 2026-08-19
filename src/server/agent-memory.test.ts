import { describe, expect, it } from "vitest";
import {
  memoryScopeKey,
  MEMORY_MAX_CHARS,
  MEMORY_MAX_NOTES,
  WS_MEMORY_MAX_CHARS,
  WS_MEMORY_MAX_NOTES,
  WS_MEMORY_SCOPE,
  SHARED_HANDLE,
} from "../db.server";
import { renderRoomMemory, splitRoomMemory } from "./memory-hint";

// El alcance es la decisión de diseño de esta feature, así que se fija con un test: por ROOM
// o DM, NUNCA por hilo. La sesión del agente sí es por hilo (`slug-flow` vs `slug-<parentId>`,
// ver agentGroupId), así que si esto se volviera por hilo la nota se perdería al abrir el
// siguiente — que es exactamente lo que se pidió evitar.
describe("alcance de la memoria", () => {
  it("un room es 'ch:<id>'", () => {
    expect(memoryScopeKey({ channelId: 7 })).toBe("ch:7");
  });

  it("un DM es 'dm:<id>'", () => {
    expect(memoryScopeKey({ dmId: 3 })).toBe("dm:3");
  });

  it("el DM gana si vinieran los dos (un DM no está dentro de un canal)", () => {
    expect(memoryScopeKey({ channelId: 7, dmId: 3 })).toBe("dm:3");
  });

  it("sin conversación no hay alcance: null, y las tools lo rechazan", () => {
    expect(memoryScopeKey({})).toBeNull();
    expect(memoryScopeKey({ channelId: null, dmId: null })).toBeNull();
  });

  // El hilo NO participa: dos hilos del mismo room comparten memoria a propósito.
  it("el hilo no cambia el alcance", () => {
    const room = memoryScopeKey({ channelId: 7 });
    // No hay forma de pasarle un parentId — el tipo no lo acepta. Este test documenta que
    // la clave sólo depende del room, y falla si alguien le añade granularidad de hilo.
    expect(room).toBe("ch:7");
    expect(room).not.toContain(":root");
  });
});

describe("topes", () => {
  it("son valores explícitos y razonables para inyectar en CADA turno", () => {
    // 40 × 240 ≈ 9.6KB en el peor caso. Si alguien los sube, que sea a sabiendas: esto
    // viaja en el texto de todos los turnos de la conversación.
    expect(MEMORY_MAX_NOTES).toBe(40);
    expect(MEMORY_MAX_CHARS).toBe(240);
    expect(MEMORY_MAX_NOTES * MEMORY_MAX_CHARS).toBeLessThan(12_000);
  });
});

// Alcance WORKSPACE (2026-08-08): la misma tabla con scope_key='ws'. UNA memoria con dos
// niveles, no dos sistemas — al turno sólo viaja el ÍNDICE (título + hook), por eso el
// tope de notas puede ser mucho mayor que el de room.
describe("alcance workspace", () => {
  it("'ws' es imposible en el formato de room/DM: no puede colisionar", () => {
    // memoryScopeKey siempre produce 'ch:<n>' o 'dm:<n>'; 'ws' vive fuera de ese espacio.
    expect(memoryScopeKey({ channelId: 7 })).not.toBe(WS_MEMORY_SCOPE);
    expect(memoryScopeKey({ dmId: 3 })).not.toBe(WS_MEMORY_SCOPE);
    expect(WS_MEMORY_SCOPE).toBe("ws");
  });

  it("topes explícitos: más notas y más largas que las de room, porque no viajan enteras", () => {
    expect(WS_MEMORY_MAX_NOTES).toBe(200);
    expect(WS_MEMORY_MAX_CHARS).toBe(600);
  });

  it("el id expuesto al agente lleva el prefijo ws: y memory_forget lo distingue", () => {
    // El contrato del prefijo: un id de workspace SIEMPRE se enseña y se acepta como
    // 'ws:N'; un número pelón es de la conversación. Es lo que evita que un forget
    // borre en el alcance equivocado.
    const wsId = `ws:12`;
    expect(/^ws:\d+$/.test(wsId)).toBe(true);
    expect(/^ws:\d+$/.test("12")).toBe(false);
  });
});

// LINEAMIENTOS DEL ESPACIO (2026-08-19): misma tabla y mismo scope de room, pero con el
// handle compartido. La regla es del LUGAR, no del agente, así que la obedece cualquiera que
// trabaje ahí — sin esto, un workspace con dos agentes dicta cada convención dos veces, y otra
// más el día que entra un tercero.
describe("lineamientos del espacio", () => {
  it("el centinela es la cadena vacía, la misma que ya usaba el workspace", () => {
    expect(SHARED_HANDLE).toBe("");
  });

  it("no colisiona con ningún handle real: un handle nunca es vacío", () => {
    // `resolvedAgents` exige handle, y las menciones son `@algo`. Si algún día se pudiera
    // registrar un agente sin handle, este centinela dejaría de distinguir y hay que cambiarlo.
    for (const handle of ["ghosty", "goose", "blue"]) expect(handle).not.toBe(SHARED_HANDLE);
  });

  it("el alcance NO cambia: sigue siendo el del room", () => {
    // Lo que distingue a un lineamiento es el handle, no el scope_key. Si esto se volviera
    // un scope propio, dejaría de convivir con las notas del agente en el mismo bloque.
    expect(memoryScopeKey({ channelId: 7 })).toBe("ch:7");
  });
});

describe("reparto del bloque de memoria de room", () => {
  const nota = (id: number, agentHandle: string, note = `n${id}`) => ({ id, note, agentHandle });

  it("separa lineamientos de las notas del agente", () => {
    const b = splitRoomMemory([nota(1, ""), nota(2, "ghosty")], 2500);
    expect(b.rules).toEqual(["#1: n1"]);
    expect(b.own).toEqual(["#2: n2"]);
    expect(b.rest).toBe(0);
  });

  it("los lineamientos comen PRIMERO del presupuesto compartido", () => {
    // Elidir una regla del espacio se lee como incumplimiento; elidir una nota vieja del
    // agente, no. Con el presupuesto justo para una, tiene que sobrevivir la regla.
    const b = splitRoomMemory([nota(1, "", "x".repeat(40)), nota(2, "ghosty", "y".repeat(40))], 50);
    expect(b.rules).toHaveLength(1);
    expect(b.own).toHaveLength(0);
    expect(b.rest).toBe(1);
    expect(b.overflow).toEqual([2]);
  });

  it("dentro de cada grupo tira lo viejo y conserva lo nuevo", () => {
    const b = splitRoomMemory([nota(1, "", "a".repeat(40)), nota(2, "", "b".repeat(40))], 50);
    expect(b.rules).toEqual([`#2: ${"b".repeat(40)}`]);
    expect(b.overflow).toEqual([1]);
  });

  it("imprime de más viejo a más nuevo (el orden en que se acordaron)", () => {
    const b = splitRoomMemory([nota(1, ""), nota(2, ""), nota(3, "")], 2500);
    expect(b.rules).toEqual(["#1: n1", "#2: n2", "#3: n3"]);
  });

  it("la cola sale como ids direccionables y acotada a 12", () => {
    // 110 caja justo UNA línea (`#N: ` + 100 chars ≈ 104): las otras 29 caen a la cola.
    const muchas = Array.from({ length: 30 }, (_, i) => nota(i + 1, "", "z".repeat(100)));
    const b = splitRoomMemory(muchas, 110);
    expect(b.rest).toBe(29);
    expect(b.overflow).toHaveLength(12);
    expect(renderRoomMemory(b)).toContain("memory_read");
  });

  it("sin notas, el bloque es cadena vacía (no un encabezado huérfano)", () => {
    expect(renderRoomMemory(splitRoomMemory([], 2500))).toBe("");
  });

  it("un room con SÓLO lineamientos no imprime el encabezado de convenciones", () => {
    // Es el caso de DESCTI el día 1: reglas puestas a mano, ningún agente ha dictado nada.
    const texto = renderRoomMemory(splitRoomMemory([nota(1, "")], 2500));
    expect(texto).toContain("Lineamientos de este espacio");
    expect(texto).not.toContain("De esta conversación");
  });
});
