// Cliente A2A: derivación de capacidades desde el card y lectura del stream.
//
// Lo que se prueba aquí es lo que nos separa de un agente ajeno: qué creemos que sabe
// hacer (y por tanto qué le promete el prompt al usuario), y cómo interpretamos su cable.
import { describe, expect, it, vi, beforeEach } from "vitest";

import { EXT, fetchCard, interfaceOf, runA2ATurn, supportsFromCard, supportsSteer } from "./a2a-client.server";

const card = (over: Record<string, unknown> = {}) => ({
  name: "Externo",
  supportedInterfaces: [{ url: "https://otro.example/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
  capabilities: { streaming: true },
  ...over,
});

/** Servidor falso: una respuesta SSE armada a partir de frames A2A. */
function sseResponse(frames: unknown[]) {
  const body = frames.map((f) => `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: f })}\n\n`).join("");
  return new Response(new Blob([body]).stream(), { status: 200, headers: { "content-type": "text/event-stream" } });
}

beforeEach(() => {
  vi.restoreAllMocks();
  delete process.env.GHOSTY_PARTNER_SECRET;
});

describe("capacidades derivadas del card", () => {
  it("un card que no declara nada da todo false — degradación segura", () => {
    // Es el punto entero de RuntimeSupports: el prompt no puede prometer notas de voz que
    // el agente no sabe dar.
    expect(supportsFromCard(card())).toEqual({
      voiceNote: false,
      sessionReset: false,
      connectorTools: false,
      ownsPersona: false,
      modelEscalation: false,
    });
  });

  it("las extensiones del card encienden capacidades", () => {
    const s = supportsFromCard(
      card({ capabilities: { extensions: [{ uri: EXT.sessionReset }, { uri: EXT.ownsPersona }] } }),
    );
    expect(s.sessionReset).toBe(true);
    expect(s.ownsPersona).toBe(true);
    expect(s.connectorTools).toBe(false);
  });

  it("la voz se infiere de un skill o de los modos de salida", () => {
    expect(supportsFromCard(card({ skills: [{ id: "voice-note" }] })).voiceNote).toBe(true);
    expect(supportsFromCard(card({ defaultOutputModes: ["audio/mpeg"] })).voiceNote).toBe(true);
  });

  it("reconoce la extensión de STEER", () => {
    expect(supportsSteer(card())).toBe(false);
    expect(supportsSteer(card({ capabilities: { extensions: [{ uri: EXT.steer }] } }))).toBe(true);
  });
});

describe("selección de interfaz", () => {
  it("ignora bindings que no sabemos hablar", () => {
    const c = card({
      supportedInterfaces: [
        { url: "https://x/grpc", protocolBinding: "GRPC" },
        { url: "https://x/rpc", protocolBinding: "JSONRPC" },
      ],
    });
    expect(interfaceOf(c)?.url).toBe("https://x/rpc");
    expect(interfaceOf(card({ supportedInterfaces: [{ url: "https://x/g", protocolBinding: "GRPC" }] }))).toBeNull();
  });
});

describe("caché del card", () => {
  it("no repite el GET dentro del TTL", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(card()));
    const url = `https://cache.example/${Math.random()}/card`;
    await fetchCard(url);
    await fetchCard(url);
    expect(f).toHaveBeenCalledTimes(1); // sin esto cada turno pagaría un RTT extra
  });

  it("si el origen falla, se sigue con el último card conocido", async () => {
    const url = `https://flaky.example/${Math.random()}/card`;
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json(card({ name: "Bueno" })));
    await fetchCard(url);
    f.mockResolvedValueOnce(new Response("boom", { status: 500 }));
    // El agente no debe caerse porque su origen tuvo un mal minuto.
    expect((await fetchCard(url, { force: true })).name).toBe("Bueno");
  });
});

describe("turno por SendStreamingMessage", () => {
  const turno = (frames: unknown[], extra: Record<string, unknown> = {}) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) =>
      String(input).endsWith("/card") ? Response.json(card()) : sseResponse(frames),
    );
    const chunks: string[] = [];
    const tools: unknown[] = [];
    return {
      chunks,
      tools,
      run: () =>
        runA2ATurn({
          cardUrl: "https://otro.example/card",
          contextId: "conv-1",
          text: "hola",
          workspaceNs: "ws1",
          onChunk: (c) => void chunks.push(c),
          onTool: (t) => void tools.push(t),
          ...extra,
        }),
    };
  };

  it("acumula los deltas del artifact y los emite en orden", async () => {
    const t = turno([
      { task: { id: "t1", contextId: "conv-1", status: { state: "TASK_STATE_SUBMITTED" } } },
      { artifactUpdate: { artifact: { parts: [{ text: "hola " }] }, append: true } },
      { artifactUpdate: { artifact: { parts: [{ text: "mundo" }] }, append: true } },
      { statusUpdate: { status: { state: "TASK_STATE_COMPLETED" } } },
    ]);
    expect(await t.run()).toBe("hola mundo");
    expect(t.chunks).toEqual(["hola ", "mundo"]);
  });

  it("traduce el DataPart de tool al checklist", async () => {
    const t = turno([
      { statusUpdate: { status: { state: "TASK_STATE_WORKING", message: { parts: [{ data: { tool: "Read", toolId: "x1", phase: "start", detail: "a.ts" } }] } } } },
      { statusUpdate: { status: { state: "TASK_STATE_WORKING", message: { parts: [{ data: { toolId: "x1", phase: "end", ok: true } }] } } } },
      { statusUpdate: { status: { state: "TASK_STATE_COMPLETED" } } },
    ]);
    await t.run();
    expect(t.tools).toEqual([
      { name: "Read", id: "x1", phase: "start", ok: undefined, detail: "a.ts" },
      { name: undefined, id: "x1", phase: "end", ok: true, detail: undefined },
    ]);
  });

  it("un Message suelto también cuenta como respuesta", async () => {
    const t = turno([{ message: { parts: [{ text: "respuesta directa" }] } }]);
    expect(await t.run()).toBe("respuesta directa");
  });

  it("FAILED se propaga como error con el motivo del agente", async () => {
    const t = turno([
      { statusUpdate: { status: { state: "TASK_STATE_FAILED", message: { parts: [{ text: "me quedé sin cuota" }] } } } },
    ]);
    await expect(t.run()).rejects.toThrow("me quedé sin cuota");
  });

  it("REJECTED (la flota del otro a tope) se distingue de un fallo", async () => {
    const t = turno([{ statusUpdate: { status: { state: "TASK_STATE_REJECTED" } } }]);
    await expect(t.run()).rejects.toThrow(/a tope/);
  });

  it("los heartbeats no ensucian el texto", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      if (String(input).endsWith("/card")) return Response.json(card());
      const body =
        `: hb\n\n` +
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { artifactUpdate: { artifact: { parts: [{ text: "ok" }] } } } })}\n\n` +
        `: hb\n\n`;
      return new Response(new Blob([body]).stream(), { status: 200 });
    });
    const chunks: string[] = [];
    const out = await runA2ATurn({
      cardUrl: "https://otro.example/card",
      contextId: "c",
      text: "hola",
      workspaceNs: "ws1",
      onChunk: (c) => void chunks.push(c),
    });
    expect(out).toBe("ok");
    expect(chunks).toEqual(["ok"]);
  });
});

describe("🔴 frontera de seguridad: a quién se le firma", () => {
  const headersDe = async (endpoint: string) => {
    process.env.GHOSTY_PARTNER_SECRET = "secreto-de-plataforma";
    let visto: Record<string, string> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init: any) => {
      if (String(input).endsWith("/card")) {
        return Response.json(card({ supportedInterfaces: [{ url: endpoint, protocolBinding: "JSONRPC" }] }));
      }
      visto = init?.headers ?? {};
      return sseResponse([{ statusUpdate: { status: { state: "TASK_STATE_COMPLETED" } } }]);
    });
    await runA2ATurn({
      cardUrl: `https://host-${Math.random()}.example/card`,
      contextId: "c",
      text: "hola",
      workspaceNs: "ws1",
      agentToken: "tok-del-agente",
      onChunk: () => {},
    });
    return visto;
  };

  it("a un host AJENO nunca se le manda la firma de partner", async () => {
    // Una firma vale 300s y es reusable: mandarla a un host que el usuario eligió sería
    // regalársela a quien quiera usarla contra nosotros.
    const h = await headersDe("https://atacante.example/a2a");
    expect(h["x-ghosty-sig"]).toBeUndefined();
    expect(h["x-ghosty-ws"]).toBeUndefined();
    expect(h.Authorization).toBe("Bearer tok-del-agente");
  });

  it("a un host NUESTRO sí, con el canonical que lleva el workspace", async () => {
    const h = await headersDe("https://www.ghosty.studio/a2a/x");
    expect(h["x-ghosty-sig"]).toMatch(/^[0-9a-f]{64}$/);
    expect(h["x-ghosty-ws"]).toBe("ws1");
    expect(h.Authorization).toBeUndefined();
  });

  it("las cajas de la flota cuentan como nuestras", async () => {
    const h = await headersDe("https://sb-abc-3000.sandboxes.easybits.cloud/a2a");
    expect(h["x-ghosty-sig"]).toBeDefined();
  });
});
