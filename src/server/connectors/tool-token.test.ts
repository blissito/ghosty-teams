// El token-capacidad: lo que un portador es (`sub`), dónde puede leer (`dest`), a qué
// workspace pertenece (`ns`) y qué puede ejercer (`scope`). Todo firmado, nada del body.
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.GHOSTY_PARTNER_SECRET = "secreto-de-prueba";
});

const mod = () => import("./tool-token.server");

describe("los claims nuevos", () => {
  it("un token SIN scope vale como `completo` — la retrocompat que protege a los nativos", async () => {
    const { mintToolToken, verifyToolToken } = await mod();
    // Exactamente lo que emiten hoy todos los call-sites existentes.
    const t = mintToolToken("ana", "ns-1", { channelId: 4 });
    expect(verifyToolToken(t)).toMatchObject({ sub: "ana", ns: "ns-1", scope: "completo" });
  });

  it("un scope desconocido cae a `lectura`, no a `completo`", async () => {
    const { mintToolToken, verifyToolToken } = await mod();
    // Si mañana aparece un scope nuevo y un emisor viejo lo emite mal, que el error sea de
    // MENOS permiso y no de más.
    const t = mintToolToken("ana", "ns-1", null, 900, { scope: "inventado" as never });
    expect(verifyToolToken(t)?.scope).toBe("lectura");
  });

  it("el `aud` viaja dentro de la firma, así que el portador no puede redirigirse solo", async () => {
    const { mintToolToken, verifyToolToken } = await mod();
    const aud = "https://acme.ghosty.mx/api/connectors/tools";
    const t = mintToolToken("ana", "ns-1", null, 900, { aud, scope: "lectura" });
    const payload = JSON.parse(Buffer.from(t.split(".")[0], "base64url").toString());
    expect(payload.aud).toBe(aud);
    // Y si alguien lo edita para apuntar a otro host, la firma deja de valer: sin esto, el
    // destino sería sugerible desde fuera y el token acabaría en un `Bearer` hacia un
    // servidor ajeno.
    const otro = { ...payload, aud: "https://malo.example/roba" };
    const falso = Buffer.from(JSON.stringify(otro)).toString("base64url") + "." + t.split(".")[1];
    expect(verifyToolToken(falso)).toBeNull();
  });
});
