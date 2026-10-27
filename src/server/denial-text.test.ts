import { describe, expect, it } from "vitest";
import { denialText } from "./ghosty-runtime.server";

describe("denialText", () => {
  it("vuelve saltos sencillos en saltos duros y respeta los párrafos", () => {
    expect(denialText({ message: "Paso 1\nPaso 2\n\nFin" })).toBe("Paso 1  \nPaso 2\n\nFin");
  });
  it("agrega la liga que viene aparte si el texto no la trae", () => {
    const t = denialText({ message: "Pega tu llave.", setupUrl: "https://www.ghosty.studio/app/settings/credentials" });
    expect(t).toBe("Pega tu llave.\n\nhttps://www.ghosty.studio/app/settings/credentials");
    expect(denialText({ message: "Ve a https://x.test/pay", payUrl: "https://x.test/pay" })).toBe("Ve a https://x.test/pay");
  });
  it("sin mensaje dice el genérico", () => {
    expect(denialText(null)).toBe("Este agente se quedó sin saldo.");
  });
});
