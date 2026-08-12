import { describe, expect, it } from "vitest";
import { shouldChime, type ChimeCtx, type ChimeMsg } from "./chime";

// Estas reglas vivían inline en la ruta del chat. Salieron para que el room abierto suene
// igual, y el test existe porque cada "no suena" de aquí es una queja real de producto: un
// chat que suena por lo que TÚ escribiste, o por una caja vacía del agente, o por algo que
// tienes delante, molesta más que uno que no suena.

const YO = { miSub: "ana", miNombre: "Ana", miHandle: "ana" };
const ctx = (over: Partial<ChimeCtx> = {}): ChimeCtx => ({
  ...YO,
  activeScope: false,
  mutes: new Set<string>(),
  ...over,
});
const msg = (over: Partial<ChimeMsg> = {}): ChimeMsg => ({
  kind: "msg",
  body: "hola",
  sender: "Beto",
  sender_sub: "beto",
  channel_id: 7,
  dm_id: null,
  ...over,
});

describe("shouldChime", () => {
  it("un mensaje de otra persona en un room suena", () => {
    expect(shouldChime(msg(), ctx())).toBe("room");
  });

  it("lo MÍO no suena", () => {
    // Llega por SSE sin match de nonce (eco tardío, otra pestaña, otro dispositivo).
    expect(shouldChime(msg({ sender_sub: "ana" }), ctx())).toBeNull();
  });

  it("lo mío tampoco suena en mensajes viejos sin `sender_sub`", () => {
    expect(shouldChime(msg({ sender_sub: null, sender: "Ana" }), ctx())).toBeNull();
  });

  it("la CÁSCARA del agente no suena — nace vacía", () => {
    // Su sonido va al primer token. Aquí sonaría antes de que el agente diga nada.
    expect(shouldChime(msg({ agent_handle: "ghosty", mentions_ghosty: 0 }), ctx())).toBeNull();
  });

  it("un mensaje que MENCIONA al agente sí suena — lo escribió una persona", () => {
    // Lleva `agent_handle` porque lo tagueó, pero `mentions_ghosty` = 1: no es la cáscara.
    expect(shouldChime(msg({ agent_handle: "ghosty", mentions_ghosty: 1 }), ctx())).toBe("room");
  });

  it("un scope silenciado no suena", () => {
    expect(shouldChime(msg(), ctx({ mutes: new Set(["room:7"]) }))).toBeNull();
    expect(shouldChime(msg({ dm_id: 3 }), ctx({ mutes: new Set(["dm:3"]) }))).toBeNull();
  });

  it("lo que estoy MIRANDO no suena", () => {
    expect(shouldChime(msg(), ctx({ activeScope: true }))).toBeNull();
  });

  it("los status (llamadas, altas) no suenan", () => {
    expect(shouldChime(msg({ kind: "status" }), ctx())).toBeNull();
  });

  it("un DM manda sobre la mención: es la señal más fuerte", () => {
    expect(shouldChime(msg({ dm_id: 3, body: "@ana mira" }), ctx())).toBe("dm");
  });

  it("mencionarme a mí suena distinto que un mensaje cualquiera", () => {
    expect(shouldChime(msg({ body: "oye @ana ¿lo viste?" }), ctx())).toBe("mention");
    expect(shouldChime(msg({ body: "oye @beto ¿lo viste?" }), ctx())).toBe("room");
  });

  it("las menciones GRUPALES cuentan como mención", () => {
    for (const g of ["@all", "@everyone", "@todos", "@room", "@here", "@aquí", "@channel"]) {
      expect(shouldChime(msg({ body: `${g} junta en 5` }), ctx())).toBe("mention");
    }
  });

  it("sin handle propio, una mención ajena no me suena como mención", () => {
    // Un invitado de un room abierto no tiene @handle. Sin este caso, cualquier `@algo`
    // le sonaría como si lo nombraran.
    expect(shouldChime(msg({ body: "@beto ¿vienes?" }), ctx({ miHandle: null }))).toBe("room");
  });
});
