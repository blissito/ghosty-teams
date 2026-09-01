// El despertador: un WebSocket NO resucita una microVM dormida, sólo una petición HTTP.
//
// Sin esto, el primer turno tras unas horas de silencio falla y el segundo funciona — la
// peor forma de esconder un bug, porque "reintenta" parece arreglarlo.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { acpHandshake, wakeBox } from "./acp-client.server";

let server: http.Server;
let wss: WebSocketServer;
let url = "";
/** Todo lo que llegó por HTTP, en orden. */
let hits: string[] = [];
/** Cuándo se abrió el primer WebSocket, para comprobar el ORDEN. */
let wsOpenedAt = 0;
let httpAt = 0;
/** Si está puesto, el HTTP contesta 404 con ese cuerpo (el del router cuando no hay caja). */
let notFoundBody: string | null = null;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    httpAt = Date.now();
    if (notFoundBody) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end(notFoundBody);
      return;
    }
    // Lo que contesta una caja viva a una ruta que no conoce. Despierta igual: el resume
    // ocurre en el proxy ANTES de enrutar.
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    if (!wsOpenedAt) wsOpenedAt = Date.now();
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentInfo: { name: "ghosty" } } }));
    });
  });
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/acp`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  hits = [];
  wsOpenedAt = 0;
  httpAt = 0;
  notFoundBody = null;
});

describe("wakeBox", () => {
  it("pide la RAÍZ, no /health", async () => {
    await wakeBox(url);
    // ⚠️ `/health` lo contesta el sandbox-router él mismo, sin tocar el daemon: medido
    // contra una caja viva devuelve `ok` en 2 bytes. Un despertador por ahí no despierta
    // nada y no habría forma de notarlo.
    expect(hits).toEqual(["/"]);
  });

  it("el 404 del router (caja reciclada) se distingue del 404 del agente", async () => {
    notFoundBody = "preview host not found";
    expect(await wakeBox(url)).toEqual({ gone: true });
    notFoundBody = null;
    // Mismo status, significado opuesto: el del agente sólo dice que esa ruta no existe.
    expect(await wakeBox(url + "?x=1")).toEqual({ gone: false });
  });

  it("una caja muerta NO revienta: el socket dirá si de verdad no hay nadie", async () => {
    // Puerto cerrado: ECONNREFUSED.
    await expect(wakeBox("ws://127.0.0.1:1/acp")).resolves.toEqual({ gone: false });
  });
});

describe("el handshake despierta antes de conectar", () => {
  it("el HTTP ocurre ANTES de abrir el WebSocket", async () => {
    const hs = await acpHandshake({ wsUrl: url, ns: "acme", sub: "u1" });
    expect(hs.agentName).toBe("ghosty");
    expect(hits[0]).toBe("/");
    expect(httpAt).toBeLessThanOrEqual(wsOpenedAt);
  });

  it("no vuelve a despertar la misma caja al momento", async () => {
    // Servidor PROPIO: la caché es por host y vive en el módulo, así que reusar el de
    // arriba haría pasar este test sin probar nada (ya estaría caliente del anterior).
    const propios: string[] = [];
    const srv = http.createServer((req, res) => {
      propios.push(req.url ?? "");
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const w = new WebSocketServer({ server: srv });
    w.on("connection", (ws) =>
      ws.on("message", (raw) => {
        const m = JSON.parse(String(raw));
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1 } }));
      }),
    );
    const u = `ws://127.0.0.1:${(srv.address() as AddressInfo).port}/acp`;
    try {
      await acpHandshake({ wsUrl: u, ns: "acme", sub: "u1" });
      expect(propios.filter((h) => h === "/")).toHaveLength(1);
      // Una conversación viva no paga el despertador en cada turno; sólo tras una pausa.
      await acpHandshake({ wsUrl: u, ns: "acme", sub: "u1" });
      expect(propios.filter((h) => h === "/")).toHaveLength(1);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it("si el despertador falla, el handshake sigue adelante", async () => {
    // Que el despertador no conteste casi siempre significa que ya estaba despierta.
    // Tumbar el turno por eso cambia un fallo raro por uno seguro.
    notFoundBody = null;
    const hs = await acpHandshake({ wsUrl: url, ns: "acme", sub: "u1", timeoutMs: 3000 });
    expect(hs.protocolVersion).toBe(1);
  });
});
