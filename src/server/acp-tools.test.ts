// Quién merece un token-capacidad en un turno ACP. Es una regla de seguridad, así que vive
// en una función propia y se prueba sola: la versión anterior estaba enterrada en un `if` a
// mitad de una función de 200 líneas que ningún test podía alcanzar.
import { beforeAll, describe, expect, it } from "vitest";

import { acpToolToken } from "./acp-tools.server";
import { parseScope } from "./connectors/tool-token.server";

beforeAll(() => {
  process.env.GHOSTY_PARTNER_SECRET = "secreto-de-prueba";
});

const base = {
  invokerSub: "ana",
  ns: "ns-1",
  dest: { channelId: 9, parentId: 4 },
  origin: "https://acme.ghosty.mx",
  scope: parseScope("lectura"),
};

const claims = (t: string) => JSON.parse(Buffer.from(t.split(".")[0], "base64url").toString());

describe("el token de tools de un turno ACP", () => {
  it("lleva firmados quién, dónde, de qué espacio y hasta dónde", async () => {
    const t = await acpToolToken(base);
    expect(t).toBeTruthy();
    expect(claims(t!)).toMatchObject({
      sub: "ana",
      ns: "ns-1",
      dest: { channelId: 9, parentId: 4 },
      scope: "lectura",
      aud: "https://acme.ghosty.mx/api/connectors/tools",
    });
  });

  it("🔴 en un canal PÚBLICO no se mintea, aunque haya invocador", async () => {
    // La frontera que ya existía para los nativos: el texto del turno lo escribe un extraño,
    // y un agente con tools sería su canal de exfiltración.
    expect(await acpToolToken({ ...base, publicChannel: true })).toBeUndefined();
  });

  it("sin invocador no hay a nombre de quién actuar", async () => {
    expect(await acpToolToken({ ...base, invokerSub: null })).toBeUndefined();
    expect(await acpToolToken({ ...base, invokerSub: "" })).toBeUndefined();
  });

  it("sin origin no se mintea: un token sin destino acabaría buscándose uno", async () => {
    expect(await acpToolToken({ ...base, origin: null })).toBeUndefined();
  });

  it("sin secreto de plataforma degrada a turno sin tools, NO a turno roto", async () => {
    const antes = process.env.GHOSTY_PARTNER_SECRET;
    delete process.env.GHOSTY_PARTNER_SECRET;
    // `mintToolToken` lanza sin el secreto. Si eso subiera, un deploy mal configurado tumbaría
    // todos los turnos ACP en vez de dejarlos sin herramientas.
    await expect(acpToolToken(base)).resolves.toBeUndefined();
    process.env.GHOSTY_PARTNER_SECRET = antes;
  });

  it("el scope del agente viaja tal cual: `completo` sólo si alguien lo eligió", async () => {
    expect(claims((await acpToolToken({ ...base, scope: parseScope("completo") }))!).scope).toBe("completo");
  });
});
