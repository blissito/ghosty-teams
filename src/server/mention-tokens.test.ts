import { describe, expect, it } from "vitest";
import { mentionTokens } from "./mentions.server";

describe("menciones sin falsos positivos", () => {
  it("versiones de paquetes, scopes de npm y código no son menciones", () => {
    const body = "Instalé `nodemailer@9.1.1`, sharp@0.35.5 y @xmldom/xmldom. Correo: ana@acme.mx. ```\n@build\n```";
    expect(mentionTokens(body)).toEqual([]);
  });
  it("las menciones reales siguen", () => {
    expect(mentionTokens("@fixtergeek revisa esto, y @todos atentos")).toEqual(["fixtergeek", "todos"]);
    expect(mentionTokens("Listo (@ana).")).toEqual(["ana"]);
  });
});
