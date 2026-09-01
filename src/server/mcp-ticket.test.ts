// El ticket de la URL MCP. Lo que se prueba aquí es que NO sea una llave: firma, caducidad,
// y que su contenido diga sólo QUÉ conversación es.
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.GHOSTY_PARTNER_SECRET = "secreto-de-prueba";
});
const { mintMcpTicket, verifyMcpTicket } = await import("./mcp-ticket.server");

const t = { ns: "acme", agent: "gemini", groupId: "ws-acme-ghosty-chat-gemini-general" };

describe("ticket MCP", () => {
  it("va y vuelve", () => {
    expect(verifyMcpTicket(mintMcpTicket(t))).toEqual(t);
  });

  // Lo que lo hace inofensivo: NO lleva `sub`, ni `dest`, ni `scope`. Quien lo robe no puede
  // ejercer nada — esos tres salen del turno en vuelo, en cada llamada.
  it("no lleva identidad ni permisos dentro", () => {
    const [payload] = mintMcpTicket(t).split(".");
    const claro = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(Object.keys(claro).sort()).toEqual(["agent", "exp", "groupId", "ns"]);
  });

  it("una firma alterada no pasa", () => {
    const bueno = mintMcpTicket(t);
    const [payload, sig] = bueno.split(".");
    expect(verifyMcpTicket(`${payload}.${sig.slice(0, -2)}xx`)).toBeNull();
    // Y el payload tampoco se puede reescribir: cambiar el groupId invalida la firma.
    const otro = Buffer.from(JSON.stringify({ ...t, groupId: "otro", exp: 9e9 })).toString("base64url");
    expect(verifyMcpTicket(`${otro}.${sig}`)).toBeNull();
  });

  it("basura y vacío no revientan", () => {
    for (const x of ["", "sin-punto", "a.b", "..", "null.null"]) expect(verifyMcpTicket(x)).toBeNull();
  });
});
