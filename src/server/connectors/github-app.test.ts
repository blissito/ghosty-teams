import { afterEach, describe, expect, it } from "vitest";
import { botIdentityEnabled, coAuthorTrailer } from "./github-app.server";

const limpia = () => {
  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_APP_PRIVATE_KEY;
  // ⚠️ Sin borrar TAMBIÉN la B64, el .env de desarrollo la deja puesta y estas pruebas
  // pasan por la razón equivocada: dieron verde tapando una llave malformada.
  delete process.env.GITHUB_APP_PRIVATE_KEY_B64;
};
afterEach(limpia);

// Un PEM de mentira, pero con la FORMA que importa: cabecera en su propia línea y saltos
// reales. Uno de una sola línea ya no cuenta como configurado, que es el punto.
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nQUJD\n-----END RSA PRIVATE KEY-----\n";

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
    process.env.GITHUB_APP_PRIVATE_KEY = PEM;
    expect(botIdentityEnabled()).toBe(false);
  });

  it("se enciende con las dos", () => {
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = PEM;
    expect(botIdentityEnabled()).toBe(true);
  });

  it("acepta el PEM con los \\n escapados, que es como viaja en un env", () => {
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = PEM.replace(/\n/g, "\\n");
    expect(botIdentityEnabled()).toBe(true);
  });

  // El incidente del 2026-08-06: systemd se comió las barras y llegó
  // `-----BEGIN RSA PRIVATE KEY-----nQUJD…`. Antes eso pasaba el filtro y reventaba a
  // media escritura con "DECODER routines::unsupported"; hoy DEGRADA a operar como el
  // usuario, que es un fallo que se entiende.
  it("una llave con las barras comidas NO cuenta como configurada", () => {
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = PEM.replace(/\n/g, "n");
    expect(botIdentityEnabled()).toBe(false);
  });

  it("la B64 gana, y es la vía recomendada: no lleva ni una barra invertida", () => {
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = PEM.replace(/\n/g, "n"); // rota
    process.env.GITHUB_APP_PRIVATE_KEY_B64 = Buffer.from(PEM, "utf8").toString("base64");
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
