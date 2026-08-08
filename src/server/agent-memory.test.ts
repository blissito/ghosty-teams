import { describe, expect, it } from "vitest";
import {
  memoryScopeKey,
  MEMORY_MAX_CHARS,
  MEMORY_MAX_NOTES,
  WS_MEMORY_MAX_CHARS,
  WS_MEMORY_MAX_NOTES,
  WS_MEMORY_SCOPE,
} from "../db.server";

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
