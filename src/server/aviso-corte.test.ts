import { describe, expect, it } from "vitest";
import { avisoDeCorte, esErrorDelProveedor } from "../agents.server";

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

  // goose (ACP) no pasa por el worker: su corte llega como `stopReason` del protocolo, y
  // hasta ahora se logueaba sin usarse — el turno terminaba mudo a media faena.
  it("`length` no manda repetir lo mismo: dice cómo salir", () => {
    const a = avisoDeCorte({ subtype: "max_tokens", classification: "length" });
    expect(a).toMatch(/por partes/i);
    expect(a).not.toMatch(/sigo desde aqu/i);
  });

  it("quedarse sin pasos en ACP sí se recupera repitiendo", () => {
    expect(avisoDeCorte({ subtype: "max_turn_requests" })).toMatch(/otra vez/i);
  });
});

// El 2026-08-25 la burbuja del agente en descti decía, en inglés y sin más, el error de la
// API de Anthropic sobre el límite de imágenes. No es una respuesta: es lo que el SDK deja
// en `result.text` cuando la llamada muere sin que el modelo alcanzara a narrar nada.
describe("esErrorDelProveedor", () => {
  it("reconoce el error de límite de imágenes", () => {
    expect(
      esErrorDelProveedor(
        "An image in the conversation exceeds the dimension limit for many-image requests (2000px). Start a new session with fewer images.",
      ),
    ).toBe(true);
  });

  it("reconoce el prompt demasiado largo", () => {
    expect(esErrorDelProveedor("Error: prompt is too long: 210000 tokens > 200000")).toBe(true);
  });

  it("NO toca una respuesta de verdad", () => {
    expect(esErrorDelProveedor("Ya revisé el convenio y encontré tres cláusulas que chocan.")).toBe(false);
  });

  it("NO toca un texto largo que sólo MENCIONA el error", () => {
    const largo = "Te explico qué pasó. ".repeat(40) + "prompt is too long";
    expect(esErrorDelProveedor(largo)).toBe(false);
  });

  it("un texto vacío no es un error del proveedor", () => {
    expect(esErrorDelProveedor("   ")).toBe(false);
  });
});
