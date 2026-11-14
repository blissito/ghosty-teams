import { describe, expect, it } from "vitest";
import { waLink, waText } from "./prospeccion-wa";

describe("waText", () => {
  it("default con y sin nombre", () => {
    expect(waText(null, "Nuxiba")).toBe("Hola, me llegó su correo (soy de Nuxiba).");
    expect(waText("", "")).toBe("Hola, me llegó su correo.");
  });
  it("texto de campaña", () => {
    const tpl = "Hola, vengo por el programa Ghosty Experts (soy de {negocio}).";
    expect(waText(tpl, "Duplimedios")).toBe("Hola, vengo por el programa Ghosty Experts (soy de Duplimedios).");
    expect(waText(tpl, null)).toBe("Hola, vengo por el programa Ghosty Experts.");
  });
});

describe("waLink", () => {
  it("limpia el teléfono y codifica el texto", () => {
    expect(waLink("+52 1 771 241 2825", "Hola {negocio}", "A&B")).toBe(
      "https://wa.me/5217712412825?text=" + encodeURIComponent("Hola A&B"),
    );
  });
  it("el negocio del directorio no va en MAYÚSCULAS en el texto que manda el prospecto", () => {
    expect(waText("Vengo por Ghosty Experts (soy de {negocio}).", "DUPLIMEDIOS")).toBe("Vengo por Ghosty Experts (soy de Duplimedios).");
  });
});
