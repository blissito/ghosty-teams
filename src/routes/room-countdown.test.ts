import { describe, expect, it } from "vitest";
import { faltan } from "./room.$slug";

// La cuenta regresiva de un room con hora. Lo que se está protegiendo no es el formato
// bonito: es que el contador NO se quede corriendo hacia atrás cuando el evento empezó, y
// que no prometa una precisión que ningún evento cumple.

const T = 1_000_000;

describe("faltan", () => {
  it("cuenta días cuando falta más de uno", () => {
    expect(faltan(T + 3 * 86400, T)).toBe("en 3 días");
    expect(faltan(T + 86400 + 10, T)).toBe("en 1 día");
  });

  it("horas y minutos el mismo día", () => {
    expect(faltan(T + 2 * 3600 + 30 * 60, T)).toBe("en 2 h 30 min");
  });

  it("sólo minutos en la última hora", () => {
    expect(faltan(T + 45 * 60, T)).toBe("en 45 min");
    expect(faltan(T + 60, T)).toBe("en 1 min");
  });

  it("bajo el minuto NO cuenta segundos", () => {
    // Un contador corriendo a cero promete una puntualidad que nadie cumple, y a los 0 s
    // queda en ridículo si el evento se retrasa dos minutos.
    expect(faltan(T + 59, T)).toBe("en unos momentos");
    expect(faltan(T + 1, T)).toBe("en unos momentos");
  });

  it("una vez empezado devuelve null — el contador desaparece", () => {
    // Es la razón de ser de la función: sin esto, la cabecera diría "hace 3 h" al lado del
    // botón de entrar, o sea le diría a alguien que llegó tarde a algo que sigue pasando.
    expect(faltan(T, T)).toBeNull();
    expect(faltan(T - 1, T)).toBeNull();
    expect(faltan(T - 10 * 86400, T)).toBeNull();
  });
});
