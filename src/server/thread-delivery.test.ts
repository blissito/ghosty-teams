import { describe, expect, it } from "vitest";

/**
 * El antecedente de "modifícalo" cuando la última entrega fue un ARCHIVO.
 *
 * Caso real (2026-08-08): el agente entregó un PDF, la persona escribió "brandeado con el
 * brandkit activo", y el agente parcheó una landing page HTML de diez minutos antes. El
 * puntero del hilo (`gc_thread_artifact`) sólo conoce doc/sheet/artifact, así que un
 * `eb-file` no lo mueve y el hint seguía presentando ese artefacto como el objeto de la
 * conversación.
 *
 * Se prueba la DECISIÓN, que es donde estaba el bug: con qué fechas se enciende la regla.
 * La query vive en `db.server.ts` y el texto en `agents.server.ts`; lo que aquí importa es
 * que la comparación sea por fecha —para que la regla se APAGUE sola cuando el artefacto
 * vuelve a ser lo último— y no un simple "existe un archivo".
 */
function reglaAplica(artefactoAt: number, entrega: { at: number } | null): boolean {
  // Espejo de la condición de chat.ts / dm.ts.
  return !!entrega && entrega.at >= artefactoAt;
}

describe("antecedente de la conversación: archivo vs artefacto", () => {
  it("el archivo es POSTERIOR al artefacto → la regla se enciende", () => {
    expect(reglaAplica(1000, { at: 1200 })).toBe(true);
  });

  it("no hay archivo → la regla no existe (el artefacto es el antecedente)", () => {
    expect(reglaAplica(1000, null)).toBe(false);
  });

  it("SE APAGA SOLA: si el artefacto se editó DESPUÉS del archivo, vuelve a ser el antecedente", () => {
    // Éste es el caso que un "¿existe un archivo?" habría respondido mal para siempre:
    // tras un `eb-patch` el artefacto es lo último y pedirle cambios debe volver a él.
    expect(reglaAplica(1500, { at: 1200 })).toBe(false);
  });

  it("empate (mismo segundo) → gana el archivo", () => {
    // `unixepoch()` tiene resolución de un segundo, así que un turno que publica artefacto y
    // archivo casi a la vez empata. Se prefiere el archivo porque es lo que la persona
    // acabó de recibir en el chat.
    expect(reglaAplica(1200, { at: 1200 })).toBe(true);
  });
});
