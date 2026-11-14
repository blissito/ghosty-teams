import { describe, expect, it } from "vitest";
import { mergeCampaign } from "./campaign-config.server";

describe("mergeCampaign", () => {
  const keys = ["prospeccion_wa_phone", "prospeccion_from_name", "prospeccion_permisos"];
  const ws = { prospeccion_wa_phone: "5215643868687", prospeccion_from_name: "Rosalba", prospeccion_permisos: "x" };

  it("sin ajustes de lista: el espacio", () => {
    expect(mergeCampaign(keys, ws, {})).toEqual(ws);
  });
  it("la lista gana en llaves de campaña, aunque sea vacío", () => {
    const r = mergeCampaign(keys, ws, { prospeccion_wa_phone: "5217712412825", prospeccion_from_name: "" });
    expect(r.prospeccion_wa_phone).toBe("5217712412825");
    expect(r.prospeccion_from_name).toBe("");
  });
  it("una llave que no es de campaña nunca la pisa la lista", () => {
    expect(mergeCampaign(keys, ws, { prospeccion_permisos: "y" }).prospeccion_permisos).toBe("x");
  });
});
