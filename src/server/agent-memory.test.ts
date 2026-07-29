import { describe, expect, it } from "vitest";
import { memoryScopeKey, MEMORY_MAX_CHARS, MEMORY_MAX_NOTES } from "../db.server";

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
