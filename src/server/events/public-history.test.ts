import { describe, expect, it } from "vitest";
import { publicMessages } from "./chat";

// Convertir en abierto un room que YA EXISTÍA publicaba de golpe todo lo que el equipo
// había hablado dentro: el camino público servía los últimos 200 mensajes del room sin
// ninguna condición de fecha. No hacía falta un exploit — bastaba abrir la liga.
//
// Importa más ahora que cualquier workspace va a poder abrir rooms públicos: el room
// abierto de un despacho puede ser el mismo donde se habló del despido de alguien.

const m = (id: number, created_at: number, parent_id: number | null = null) => ({ id, created_at, parent_id });

const ANTES = [m(1, 100), m(2, 200), m(3, 300)];
const DESPUES = [m(4, 1100), m(5, 1200)];
const TODOS = [...ANTES, ...DESPUES];
const ABIERTO = 1000;

describe("publicMessages", () => {
  it("no enseña NADA anterior a la apertura", () => {
    expect(publicMessages(TODOS, ABIERTO).map((x) => x.id)).toEqual([4, 5]);
  });

  it("sin `public_since` no enseña nada — cerrado por omisión", () => {
    // Un room que nunca se abrió, o una fila anterior a la columna que por lo que sea no
    // se selló. El fallo tiene que ser hacia el silencio, nunca hacia publicar.
    expect(publicMessages(TODOS, null)).toEqual([]);
    expect(publicMessages(TODOS, undefined)).toEqual([]);
  });

  it("un mensaje EXACTAMENTE en el instante de apertura sí entra", () => {
    // El sello y el primer mensaje pueden caer en el mismo segundo (unixepoch). Con `>`
    // en vez de `>=`, ese mensaje desaparecía sin explicación.
    expect(publicMessages([m(9, ABIERTO)], ABIERTO).map((x) => x.id)).toEqual([9]);
  });

  it("las respuestas de hilo no salen al flujo", () => {
    expect(publicMessages([...DESPUES, m(6, 1300, 4)], ABIERTO).map((x) => x.id)).toEqual([4, 5]);
  });

  it("`after` no puede saltarse el corte", () => {
    // El cliente controla `after`, así que es lo primero que alguien tocaría para pedir
    // "desde el mensaje 0". El corte de fecha se aplica igual.
    expect(publicMessages(TODOS, ABIERTO, 0).map((x) => x.id)).toEqual([4, 5]);
    expect(publicMessages(TODOS, ABIERTO, -999).map((x) => x.id)).toEqual([4, 5]);
  });

  it("`after` sí avanza dentro de lo que ya es público", () => {
    expect(publicMessages(TODOS, ABIERTO, 4).map((x) => x.id)).toEqual([5]);
  });

  it("el límite recorta por el final, que es lo reciente", () => {
    const muchos = Array.from({ length: 300 }, (_, i) => m(i + 1, 2000 + i));
    const out = publicMessages(muchos, ABIERTO, 0, 200);
    expect(out).toHaveLength(200);
    expect(out[out.length - 1].id).toBe(300);
  });

  it("reabrir NO recalcula el sello — se conserva el primero", () => {
    // Es la contrapartida asumida: un room cerrado tres meses vuelve enseñando también lo
    // de antes de cerrarse. Pisar el sello con la fecha nueva sería peor: dejaría al
    // descubierto justo lo que se habló mientras estaba cerrado.
    const cerradoYReabierto = publicMessages(TODOS, ABIERTO);
    expect(cerradoYReabierto.map((x) => x.id)).toEqual([4, 5]);
  });
});
