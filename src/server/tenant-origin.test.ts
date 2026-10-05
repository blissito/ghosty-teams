import { describe, it, expect } from "vitest";
import { rebaseOrigin } from "./tenant.server";

// Renombrar el espacio (abogados → palmera-legal) dejaba los encargos en segundo plano llamando al
// host viejo: sus tools daban 403 «token de otro workspace» (3-oct).
describe("rebaseOrigin", () => {
  it("el host de otro slug pasa al slug actual", () => {
    expect(rebaseOrigin("https://abogados.teams.ghosty.studio", "palmera-legal")).toBe("https://palmera-legal.teams.ghosty.studio");
  });
  it("mismo slug, dominio propio, vacío o sin slug: igual", () => {
    expect(rebaseOrigin("https://palmera-legal.teams.ghosty.studio", "palmera-legal")).toBe("https://palmera-legal.teams.ghosty.studio");
    expect(rebaseOrigin("https://chat.cliente.com", "palmera-legal")).toBe("https://chat.cliente.com");
    expect(rebaseOrigin("", "palmera-legal")).toBe("");
    expect(rebaseOrigin("https://abogados.teams.ghosty.studio", null)).toBe("https://abogados.teams.ghosty.studio");
  });
});
