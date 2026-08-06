import { afterEach, describe, expect, it } from "vitest";
import { botIdentityEnabled, coAuthorTrailer } from "./github-app.server";

const limpia = () => {
  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_APP_PRIVATE_KEY;
};
afterEach(limpia);

describe("identidad de bot", () => {
  it("nace APAGADA: sin las dos env el conector opera como el usuario", () => {
    limpia();
    expect(botIdentityEnabled()).toBe(false);
  });

  it("con una sola env sigue apagada — media configuración es peor que ninguna", () => {
    limpia();
    process.env.GITHUB_APP_ID = "123";
    expect(botIdentityEnabled()).toBe(false);
    limpia();
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----";
    expect(botIdentityEnabled()).toBe(false);
  });

  it("se enciende con las dos", () => {
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----";
    expect(botIdentityEnabled()).toBe(true);
  });
});

describe("trailer de coautoría", () => {
  it("cae al no-reply, que SIEMPRE está asociado a la cuenta", () => {
    expect(coAuthorTrailer("lupita")).toBe("\n\nCo-authored-by: lupita <lupita@users.noreply.github.com>");
  });

  it("usa el correo real cuando lo hay", () => {
    expect(coAuthorTrailer("lupita", "lu@acme.com")).toContain("<lu@acme.com>");
  });

  it("un correo basura cae al no-reply: GitHub sólo cuenta el trailer si resuelve a una cuenta", () => {
    expect(coAuthorTrailer("lupita", "no-es-un-correo")).toContain("noreply.github.com");
  });

  it("empieza con línea en blanco — GitHub exige que el trailer vaya separado del cuerpo", () => {
    expect(coAuthorTrailer("x").startsWith("\n\n")).toBe(true);
  });
});
