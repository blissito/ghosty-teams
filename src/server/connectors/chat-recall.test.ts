// El corte de los cuerpos en `chat_search`/`chat_history` tiene que DECIRSE.
//
// El 2026-08-27 un turno de descti gastó 1.4M de cacheRead y 308 s buscando un párrafo que
// estaba detrás del corte de 800 caracteres, y acabó diciéndole al usuario que sus
// herramientas truncaban. El «…» del final no es una señal: el modelo lo lee como el final
// del mensaje. Declararlo sin dar una vía para pedir el resto tampoco basta, así que el
// invariante son las dos cosas juntas.
import { describe, expect, it } from "vitest";

import { nativeTools } from "./native.server";

const tools = nativeTools({ dmId: 1 });
const decl = (name: string) => tools.find((t) => t.name === name);

describe("recall de la conversación", () => {
  it("chat_message existe y pide ids", () => {
    const t = decl("chat_message");
    expect(t).toBeTruthy();
    expect((t!.inputSchema as { required?: string[] }).required).toEqual(["ids"]);
  });

  it("las dos tools que recortan nombran la vía para leer el resto", () => {
    for (const n of ["chat_search", "chat_history"]) {
      expect(decl(n)?.description).toContain("chat_message");
      expect(decl(n)?.description).toContain("truncated");
    }
  });
});
