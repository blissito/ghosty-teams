// Invariantes sobre CADA entrada del registro. Existen porque desde que conviven dos formas
// de conectar (OAuth y credenciales tecleadas), una entrada mal declarada NO falla ruidosa:
// la tarjeta se pinta perfecta, el botón lleva a /setup/<id>/connect, `startConnectFn` lanza
// y el catch de la ruta deposita a la persona en el chat SIN un mensaje. Parece un bug
// aleatorio y no deja rastro. Un test es la única forma barata de cazarlo.
import { describe, it, expect } from "vitest";
import { CONNECTORS } from "./registry";
import { loaderFor } from "./impl";

const disponibles = CONNECTORS.filter((c) => c.status === "available");

describe("cada conector declara UNA forma de conectarse", () => {
  it("hay conectores disponibles que probar", () => {
    expect(disponibles.length).toBeGreaterThan(0);
  });

  for (const c of disponibles) {
    it(`${c.id}: oauth XOR credentials`, () => {
      const formas = [c.oauth, c.credentials].filter(Boolean).length;
      expect(formas).toBe(1);
    });

    it(`${c.id}: tiene módulo cargable`, () => {
      expect(typeof loaderFor(c.id)).toBe("function");
    });
  }
});

describe("conectores por credenciales", () => {
  const conCreds = CONNECTORS.filter((c) => c.credentials);
  for (const c of conCreds) {
    it(`${c.id}: exactamente un campo secreto`, () => {
      expect(c.credentials!.fields.filter((f) => f.secret).length).toBe(1);
    });

    it(`${c.id}: al menos un campo host, o el guard de red no tendría qué validar`, () => {
      expect(c.credentials!.fields.some((f) => f.host)).toBe(true);
    });

    it(`${c.id}: claves de campo únicas`, () => {
      const keys = c.credentials!.fields.map((f) => f.key);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it(`${c.id}: el secreto se pide como password, nunca en claro en pantalla`, () => {
      expect(c.credentials!.fields.find((f) => f.secret)!.type).toBe("password");
    });

    it(`${c.id}: no declara campos de OAuth que mentirían`, () => {
      // `revokeUrl` es el peligroso: si migrara fuera de `oauth`, el camino de desconectar
      // mandaría la API key en claro a esa URL con client_id/secret vacíos.
      expect((c as any).oauth).toBeUndefined();
    });
  }
});

describe("ids", () => {
  it("son únicos", () => {
    const ids = CONNECTORS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
