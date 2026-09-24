import { describe, expect, it } from "vitest";
import { pickRespondents } from "./agent-handoff.server";

describe("pickRespondents", () => {
  it("un pedido de coordinación arranca sólo al primero (el caso real de #divi, con su errata)", () => {
    const body = "@ghosty cordina con @fable los trabajos para generar un documento de Modelo de Operación";
    expect(pickRespondents(body, ["ghosty", "fable"])).toEqual(["ghosty"]);
    expect(pickRespondents("@fable coordínate con @ghosty para el oficio", ["fable", "ghosty"])).toEqual(["fable"]);
    expect(pickRespondents("@ghosty trabaja con @astra en esto", ["ghosty", "astra"])).toEqual(["ghosty"]);
    expect(pickRespondents("@ghosty coordinate with @fable on the report", ["ghosty", "fable"])).toEqual(["ghosty"]);
    expect(pickRespondents("@ghosty work with @fable and ask @astra for the numbers", ["ghosty", "fable", "astra"])).toEqual(["ghosty"]);
  });
  it("sin verbo de coordinación siguen contestando todos", () => {
    expect(pickRespondents("@ghosty @fable ¿qué opinan de este oficio?", ["ghosty", "fable"])).toEqual(["ghosty", "fable"]);
    expect(pickRespondents("@ghosty coordina la reunión del lunes", ["ghosty"])).toEqual(["ghosty"]);
  });
});
