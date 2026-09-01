// El alta de un agente ACP se comprueba con `initialize`, no con una ruta HTTP nuestra.
//
// El bug que esto fija: `/busy` la expone NUESTRO relé para que el daemon sepa si puede
// congelar la microVM. GhostyCode (`ghosty serve --acp --acp-http`) contesta 404 ahí y el
// alta fallaba con «la caja respondió 404» teniendo el WebSocket sano.
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WS } from "ws";

import { acpHandshake } from "./acp-client.server";

let wss: WebSocketServer;
let url = "";
/** Qué hace el agente falso al recibir `initialize`. */
let script: (ws: WS, m: any) => void = () => {};

beforeAll(async () => {
  wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/acp`;
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => script(ws, JSON.parse(String(raw))));
  });
});
afterAll(() => wss.close());

const responde = (ws: WS, m: any, result: any) =>
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));

describe("acpHandshake", () => {
  it("saluda a un agente que contesta initialize", async () => {
    script = (ws, m) => {
      expect(m.method).toBe("initialize");
      // Sin fs ni terminal: el agente usa los de su caja. Es la misma política del turno.
      expect(m.params.clientCapabilities).toEqual({});
      responde(ws, m, {
        protocolVersion: 1,
        agentInfo: { name: "ghosty", version: "0.0.19" },
        agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
      });
    };
    const hs = await acpHandshake({ wsUrl: url, ns: "acme", sub: "u1" });
    expect(hs.agentName).toBe("ghosty");
    expect(hs.agentVersion).toBe("0.0.19");
    expect(hs.protocolVersion).toBe(1);
    expect((hs.agentCapabilities as any)?.loadSession).toBe(true);
  });

  it("no espera para siempre a un agente que abre el socket y se calla", async () => {
    script = () => {};
    await expect(acpHandshake({ wsUrl: url, ns: "acme", sub: "u1", timeoutMs: 200 })).rejects.toThrow(
      /initialize/,
    );
  });

  it("falla claro contra una caja muerta", async () => {
    await expect(
      acpHandshake({ wsUrl: "ws://127.0.0.1:1/acp", ns: "acme", sub: "u1", timeoutMs: 500 }),
    ).rejects.toThrow();
  });

  it("un cierre sin saludo es un no, no un cuelgue", async () => {
    script = (ws) => ws.close();
    await expect(
      acpHandshake({ wsUrl: url, ns: "acme", sub: "u1", timeoutMs: 5000 }),
    ).rejects.toThrow(/sin saludar/);
  });
});
