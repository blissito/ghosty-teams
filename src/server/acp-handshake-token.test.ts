// El bearer de una caja ACP ajena: que VIAJE, y que viaje en el sitio correcto.
//
// Existe porque los agentes ACP dejaron de ser sólo nuestros. Un alumno levanta GhostyCode en
// su caja, le pone un token, y sin esto el alta fallaba con un `initialize` que nunca contesta
// — indistinguible de una caja muerta.
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { acpHandshake } from "./acp-client.server";

let wss: WebSocketServer;
let url = "";
/** Lo que el servidor vio en el handshake HTTP del WebSocket. */
let headers: Record<string, string | undefined> = {};
/** Si está puesto, el servidor exige ese bearer y rechaza sin él. */
let exige: string | null = null;

beforeAll(async () => {
  wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/acp`;
  wss.on("connection", (ws, req) => {
    headers = req.headers as Record<string, string | undefined>;
    if (exige && req.headers.authorization !== `Bearer ${exige}`) {
      ws.close();
      return;
    }
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentInfo: { name: "ghosty" } } }));
    });
  });
});
afterAll(() => wss.close());

describe("token de la caja", () => {
  it("va en Authorization, NUNCA en la URL", async () => {
    exige = null;
    await acpHandshake({ wsUrl: url, ns: "acme", sub: "u1", token: "s3creto" });
    expect(headers.authorization).toBe("Bearer s3creto");
    // Una credencial en la query acaba en los access logs de cualquier proxy del camino.
    expect(headers.host && new URL(url).search).toBeFalsy();
  });

  it("sin token no manda la cabecera", async () => {
    exige = null;
    await acpHandshake({ wsUrl: url, ns: "acme", sub: "u1" });
    expect(headers.authorization).toBeUndefined();
  });

  it("una caja que lo exige rechaza al que no lo lleva", async () => {
    exige = "s3creto";
    await expect(acpHandshake({ wsUrl: url, ns: "acme", sub: "u1", timeoutMs: 800 })).rejects.toThrow();
    await expect(acpHandshake({ wsUrl: url, ns: "acme", sub: "u1", token: "s3creto" })).resolves.toMatchObject({
      agentName: "ghosty",
    });
  });
});

describe("authMethods", () => {
  it("se recogen para poder avisar: saludar no es poder trabajar", async () => {
    exige = null;
    // Es lo que contesta GhostyCode sin llave del proveedor: saluda igual, y el primer turno
    // falla. Sin esto el probe salía verde y el fallo aparecía días después en un canal.
    wss.removeAllListeners("connection");
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const m = JSON.parse(String(raw));
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: m.id,
            result: {
              protocolVersion: 1,
              agentInfo: { name: "ghosty" },
              authMethods: [{ id: "ghosty-terminal-auth", name: "Set Ghosty API key" }],
            },
          }),
        );
      });
    });
    const hs = await acpHandshake({ wsUrl: url, ns: "acme", sub: "u1" });
    expect(hs.authMethods?.[0]?.name).toBe("Set Ghosty API key");
  });
});
