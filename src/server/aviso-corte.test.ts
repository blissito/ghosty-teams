import { describe, expect, it } from "vitest";
import { avisoDeCorte } from "../agents.server";

// El caso real: DESCTI, DM con Rodrigo, 2026-08-25 13:27. El turno murió con el límite de
// imágenes de Anthropic y el aviso remató con "pídemelo otra vez" — que para esa causa es
// imposible: reintentar vuelve a chocar con el mismo límite. Abandonó ahí.
describe("avisoDeCorte", () => {
  it("🔴 en la clase `session` NO dice «pídemelo otra vez»", () => {
    const a = avisoDeCorte({ subtype: "success", classification: "session" });
    expect(a).not.toMatch(/otra vez/i);
    // Y dice por qué, o el consejo suena arbitrario.
    expect(a).toMatch(/im[aá]genes/i);
  });

  it("en la clase `session` advierte que reiniciar BORRA la memoria", () => {
    // Reiniciar es la única salida, pero en un expediente de varios días cuesta más que el
    // turno perdido. Ofrecerlo sin decirlo sería un footgun.
    expect(avisoDeCorte({ subtype: "success", classification: "session" })).toMatch(/borra la memoria/i);
  });

  it("sin clasificación conserva el consejo de siempre", () => {
    // `error_max_turns` y compañía SÍ se recuperan repitiendo: ahí el texto viejo es correcto.
    expect(avisoDeCorte({ subtype: "error_max_turns" })).toMatch(/otra vez/i);
  });
});
