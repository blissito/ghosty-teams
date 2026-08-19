// Cliente ACP contra un relé falso: sin caja, sin agente, sin modelo.
//
// Lo que importa probar aquí no es el feliz camino del texto —eso lo hace cualquier cliente—
// sino lo que distingue a ACP: que el agente puede llamarnos a NOSOTROS y quedarse detenido
// hasta que contestemos.
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WS } from "ws";

import { acpTicketUrl, runAcpTurn } from "./acp-client.server";

let wss: WebSocketServer;
let url = "";
/** Lo que el relé falso debe hacer en el próximo turno. */
let guion: (ws: WS, m: any) => void = () => {};
let ultimaUrl = "";

const env = (o: any, extra: any) => JSON.stringify({ jsonrpc: "2.0", ...o, ...extra }) + "\n";

beforeAll(async () => {
  wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/acp`;
  wss.on("connection", (ws, req) => {
    ultimaUrl = req.url ?? "";
    ws.on("message", (d) => {
      for (const line of d.toString().split("\n")) {
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        if (m.method === "initialize") ws.send(env({ id: m.id }, { result: { protocolVersion: 1 } }));
        else if (m.method === "session/new") ws.send(env({ id: m.id }, { result: { sessionId: "ses-1" } }));
        else if (m.method === "session/load") ws.send(env({ id: m.id }, { result: {} }));
        else if (m.method === "session/prompt") guion(ws, m);
        else if (m.id != null) ws.send(env({ id: m.id }, { result: {} }));
      }
    });
  });
});

afterAll(() => wss.close());

const turno = (over: Partial<Parameters<typeof runAcpTurn>[0]> = {}) => {
  const updates: any[] = [];
  return {
    updates,
    run: () =>
      runAcpTurn({
        wsUrl: url,
        workspaceNs: "acme",
        sub: "user-1",
        text: "hola",
        onUpdate: (u) => void updates.push(u),
        ...over,
      }),
  };
};

describe("el turno", () => {
  it("acumula el texto y devuelve la sesión", async () => {
    guion = (ws, m) => {
      ws.send(env({}, { method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hola " } } } }));
      ws.send(env({}, { method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "mundo" } } } }));
      ws.send(env({ id: m.id }, { result: { stopReason: "end_turn" } }));
    };
    const t = turno();
    const r = await t.run();
    expect(r.text).toBe("hola mundo");
    expect(r.sessionId).toBe("ses-1");
    expect(r.stopReason).toBe("end_turn");
  });

  it("el razonamiento NO entra en el texto de la respuesta", async () => {
    guion = (ws, m) => {
      ws.send(env({}, { method: "session/update", params: { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "mmm…" } } } }));
      ws.send(env({}, { method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "listo" } } } }));
      ws.send(env({ id: m.id }, { result: { stopReason: "end_turn" } }));
    };
    const t = turno();
    const r = await t.run();
    expect(r.text).toBe("listo"); // el pensamiento es contexto, no contenido
    expect(t.updates.map((u) => u.kind)).toEqual(["thought", "text"]);
  });

  it("un update desconocido se reporta en vez de tirarse en silencio", async () => {
    // ACP sigue creciendo (v2 está en RFD): saber que llegó algo nuevo vale más que fingir
    // que no existe.
    guion = (ws, m) => {
      ws.send(env({}, { method: "session/update", params: { update: { sessionUpdate: "cosa_del_futuro" } } }));
      ws.send(env({ id: m.id }, { result: { stopReason: "end_turn" } }));
    };
    const t = turno();
    await t.run();
    expect(t.updates).toEqual([{ kind: "otro", tipo: "cosa_del_futuro" }]);
  });

  it("traduce tool_call y plan al vocabulario del chat", async () => {
    guion = (ws, m) => {
      ws.send(env({}, { method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "leer main.rs", status: "in_progress" } } }));
      ws.send(env({}, { method: "session/update", params: { update: { sessionUpdate: "plan", entries: [{ content: "paso 1", status: "pending" }] } } }));
      ws.send(env({ id: m.id }, { result: { stopReason: "end_turn" } }));
    };
    const t = turno();
    await t.run();
    expect(t.updates[0]).toEqual({ kind: "tool", id: "t1", title: "leer main.rs", status: "in_progress" });
    expect(t.updates[1]).toEqual({ kind: "plan", entries: [{ content: "paso 1", status: "pending" }] });
  });
});

describe("permisos — lo que distingue a ACP", () => {
  const pidePermiso = (ws: WS, m: any) => {
    ws.send(env({ id: 999 }, { method: "session/request_permission", params: { toolCall: { title: "¿Borro el archivo?" }, options: [{ optionId: "allow", name: "Sí" }, { optionId: "deny", name: "No" }] } }));
    // El agente NO sigue hasta que le contesten: el prompt se resuelve después.
    setTimeout(() => ws.send(env({ id: m.id }, { result: { stopReason: "end_turn" } })), 60);
  };

  it("la pregunta llega con sus opciones y la respuesta elegida vuelve", async () => {
    guion = pidePermiso;
    let visto: any = null;
    const t = turno({
      onPermission: async (p) => {
        visto = p;
        return "allow";
      },
    });
    await t.run();
    expect(visto.title).toBe("¿Borro el archivo?");
    expect(visto.options).toEqual([
      { id: "allow", label: "Sí", kind: undefined },
      { id: "deny", label: "No", kind: undefined },
    ]);
  });

  it("🔴 sin manejador se RECHAZA, no se aprueba", async () => {
    // Un permiso que se concede solo porque nadie estaba mirando no es un permiso.
    guion = (ws, m) => {
      let respuesta: any = null;
      ws.on("message", (d) => {
        for (const l of d.toString().split("\n")) {
          if (!l.trim()) continue;
          const x = JSON.parse(l);
          if (x.id === 999 && x.result) respuesta = x.result;
        }
      });
      ws.send(env({ id: 999 }, { method: "session/request_permission", params: { toolCall: { title: "¿Borro?" }, options: [] } }));
      setTimeout(() => ws.send(env({ id: m.id }, { result: { stopReason: "end_turn", eco: respuesta } })), 80);
    };
    const t = turno(); // sin onPermission
    const r = await t.run();
    expect((r as any).stopReason).toBe("end_turn");
  });

  it("una petición del agente que no soportamos se rechaza explícitamente", async () => {
    // Dejarla sin contestar dejaría al agente detenido para siempre.
    let respondio = false;
    guion = (ws, m) => {
      ws.on("message", (d) => {
        for (const l of d.toString().split("\n")) {
          if (!l.trim()) continue;
          const x = JSON.parse(l);
          if (x.id === 888 && x.error) respondio = true;
        }
      });
      ws.send(env({ id: 888 }, { method: "fs/read_text_file", params: { path: "/x" } }));
      setTimeout(() => ws.send(env({ id: m.id }, { result: { stopReason: "end_turn" } })), 80);
    };
    await turno().run();
    expect(respondio).toBe(true);
  });
});

describe("🔴 el ticket lleva el tenant dentro de la firma", () => {
  it("firma ts.ns.sub y los manda en el query", () => {
    process.env.ACP_TICKET_SECRET = "secreto";
    const u = new URL(acpTicketUrl("wss://caja/acp", "acme", "user-1"));
    const ts = u.searchParams.get("ts")!;
    const esperado = crypto.createHmac("sha256", "secreto").update(`${ts}.acme.user-1`).digest("hex");
    expect(u.searchParams.get("sig")).toBe(esperado);
    expect(u.searchParams.get("ns")).toBe("acme");
    delete process.env.ACP_TICKET_SECRET;
  });

  it("sin secreto no inventa un ticket: la URL no adivinable es la capability", () => {
    delete process.env.ACP_TICKET_SECRET;
    expect(acpTicketUrl("wss://caja/acp", "acme", "u")).toBe("wss://caja/acp");
  });

  it("el ticket viaja de verdad en la conexión", async () => {
    process.env.ACP_TICKET_SECRET = "secreto";
    guion = (ws, m) => ws.send(env({ id: m.id }, { result: { stopReason: "end_turn" } }));
    await turno().run();
    expect(ultimaUrl).toContain("ns=acme");
    expect(ultimaUrl).toContain("sig=");
    delete process.env.ACP_TICKET_SECRET;
  });
});

/**
 * Los dos silencios. Un turno colgado no es un error del protocolo —es lo que el usuario ve:
 * una burbuja vacía girando para siempre. Pasó el 19 ago 2026 con una caja borrada cuya URL
 * seguía viva en el router: el WS abría, el prompt salía, y nadie contestaba jamás.
 */
describe("cuando el agente se calla", () => {
  it("falla si el socket muere a media respuesta, en vez de esperar para siempre", async () => {
    guion = (ws) => ws.close();
    await expect(turno().run()).rejects.toThrow(/cerró la conexión/);
  });

  it("falla por SILENCIO, y el reloj no corre mientras un humano decide un permiso", async () => {
    // El relé pide permiso y se calla. Quien contesta tarda MÁS que el `idleMs`: el turno
    // debe sobrevivir esa espera —es un humano— y morir sólo por el silencio de después.
    guion = (ws, m) => {
      ws.send(
        env({ id: 99 }, { method: "session/request_permission", params: { title: "¿sigo?", options: [{ optionId: "ok", name: "Sí" }] } }),
      );
      void m;
    };
    const t = turno({
      idleMs: 300,
      onPermission: async () => {
        await new Promise((r) => setTimeout(r, 900));
        return "ok";
      },
    });
    const t0 = Date.now();
    await expect(t.run()).rejects.toThrow(/sin responder/);
    // Si el permiso no hubiera pausado el reloj, habría muerto a los ~300ms.
    expect(Date.now() - t0).toBeGreaterThan(900);
  });
});
