import { describe, expect, it } from "vitest";
import { nextStep, type CampaignState } from "./prospeccion-campaign";

const ok: CampaignState = { ctaKind: "wa", waPhone: "5217712412825", senderName: "Héctor", hasMessage: true, testSent: true, shown: 24 };

describe("nextStep", () => {
  it("primero lo que falta de configuración", () => {
    expect(nextStep({ ...ok, waPhone: "", senderName: "" })).toEqual({ id: "setup", missing: ["whatsapp", "sender"] });
    // Sin botón de WhatsApp el número no hace falta.
    expect(nextStep({ ...ok, ctaKind: "reply", waPhone: "" })).toEqual({ id: "send", n: 24 });
  });
  it("luego el mensaje, luego la prueba, luego enviar", () => {
    expect(nextStep({ ...ok, hasMessage: false, testSent: false })).toEqual({ id: "message" });
    expect(nextStep({ ...ok, testSent: false })).toEqual({ id: "test" });
    expect(nextStep(ok)).toEqual({ id: "send", n: 24 });
  });
  it("sin filas a la vista no ofrece enviar", () => {
    expect(nextStep({ ...ok, shown: 0 })).toEqual({ id: "empty" });
  });
});
