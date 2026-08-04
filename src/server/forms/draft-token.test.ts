// El token de un borrador es un BEARER sobre un intake a medio llenar: quien lo tenga lee
// lo que esa persona lleva escrito. Todo lo que lo sostiene es la firma y el `exp`, así que
// es lo único que hay que fijar por test.
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.GHOSTY_PARTNER_SECRET ||= "test-secret-para-firmar";
});

const mod = () => import("./token.server");

describe("token de borrador", () => {
  it("va y vuelve entero", async () => {
    const { mintDraftToken, verifyDraftToken } = await mod();
    const t = mintDraftToken({ draftId: "d1", formId: "form_x", ns: "acme" }, 3600);
    expect(verifyDraftToken(t)).toEqual({ draftId: "d1", formId: "form_x", ns: "acme" });
  });

  it("una firma alterada no pasa", async () => {
    const { mintDraftToken, verifyDraftToken } = await mod();
    const t = mintDraftToken({ draftId: "d1", formId: "form_x", ns: "acme" }, 3600);
    const [p, s] = t.split(".");
    expect(verifyDraftToken(`${p}.${s.slice(0, -2)}xx`)).toBeNull();
    // Y tampoco vale reescribir el payload: la firma es de lo de antes.
    const otro = Buffer.from(JSON.stringify({ k: "draft", d: "d1", f: "form_x", n: "otro", exp: 9e9 })).toString(
      "base64url"
    );
    expect(verifyDraftToken(`${otro}.${s}`)).toBeNull();
  });

  it("caduca", async () => {
    const { mintDraftToken, verifyDraftToken } = await mod();
    // El mint tiene piso de 60s, así que la caducidad se fabrica firmando a mano — es la
    // misma comprobación que hace el verify sobre un token de hace una semana.
    const crypto = await import("node:crypto");
    const payload = Buffer.from(
      JSON.stringify({ k: "draft", d: "d1", f: "form_x", n: "acme", exp: Math.floor(Date.now() / 1000) - 10 })
    ).toString("base64url");
    const sig = crypto
      .createHmac("sha256", process.env.GHOSTY_PARTNER_SECRET!)
      .update(payload)
      .digest("base64url");
    expect(verifyDraftToken(`${payload}.${sig}`)).toBeNull();
    // El recién emitido sí.
    expect(verifyDraftToken(mintDraftToken({ draftId: "d", formId: "f", ns: "n" }, 3600))).not.toBeNull();
  });

  it("los dos tokens NO son intercambiables", async () => {
    // Ésta es la razón de que los campos se llamen `d`/`f` y no `id`/`ns`: un token de
    // borrador que pasara por `verifyFormToken` dirigiría submits con su namespace, y uno
    // de formulario que pasara por el de borradores abriría el intake de cualquiera.
    const { mintDraftToken, verifyDraftToken, mintFormToken, verifyFormToken } = await mod();
    const draft = mintDraftToken({ draftId: "d1", formId: "form_x", ns: "acme" }, 3600);
    const formT = mintFormToken({ id: "form_x", ns: "acme" });
    expect(verifyFormToken(draft)).toBeNull();
    expect(verifyDraftToken(formT)).toBeNull();
  });

  it("la basura no truena", async () => {
    const { verifyDraftToken } = await mod();
    for (const v of ["", "sin-punto", "a.b", "....", "eyJhIjoxfQ.zz"]) {
      expect(verifyDraftToken(v)).toBeNull();
    }
  });
});
