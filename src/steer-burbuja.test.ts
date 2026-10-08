// Steer en un room (palmera-legal, 7-oct): la persona escribe mientras el agente trabaja y la
// respuesta tiene que salir en burbuja propia DEBAJO de su mensaje, con ✅ en ese momento.
// Antes se pegaba a la burbuja vieja, arriba, y para ella no hubo respuesta.
import { test, expect } from "vitest";
import { runAgentTurn } from "./agents.server";

const sqldVacio = (init: any) => {
  const reqs = JSON.parse(init.body).requests as any[];
  const results = reqs.map((r) => r.type === "close" ? { type: "ok", response: { type: "close" } } : { type: "ok", response: { type: "execute", result: { cols: [], rows: [], affected_row_count: 0, last_insert_rowid: null } } });
  return new Response(JSON.stringify({ baton: null, base_url: null, results }), { status: 200, headers: { "content-type": "application/json" } });
};

async function correr(frames: any[]) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url).includes("/v2/pipeline")) return sqldVacio(init);
    return new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as any;
  const bodies: Record<number, string[]> = {};
  const cerradas: Record<number, string> = {};
  const contestados: number[][] = [];
  let next = 100;
  try {
    const r = await runAgentTurn({
      agent: { handle: "becario", name: "Becario", avatar: "", systemPrompt: null, backend: { kind: "fleet", id: "x", token: "tok", runtime: "easybits", runtimeUrl: "http://fake.local" } } as any,
      handle: "becario", groupId: "g", sender: "iris", text: "hazme la tarjeta",
      createShell: async () => 1,
      createFollowUp: async () => next++,
      emitDelta: () => {},
      emitBody: (id, b) => { (bodies[id] ??= []).push(b); },
      onSteerAnswered: (ids) => contestados.push(ids),
      closeBubble: async (id, b) => { cerradas[id] = b; },
      originOverride: "http://localhost",
    });
    return { r, bodies, cerradas, contestados };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("reply_to parte la burbuja: la respuesta al steer sale aparte y con ✅", { timeout: 30000 }, async () => {
  const { r, cerradas, contestados } = await correr([
    { type: "chunk", value: "Listo, aquí está la tarjeta." },
    { type: "reply_to", messageIds: ["456"] },
    { type: "chunk", value: "\n\nLa saco en alta calidad." },
    { type: "done", value: "Listo, aquí está la tarjeta.\n\nLa saco en alta calidad." },
  ]);
  expect(cerradas[1]).toContain("Listo, aquí está la tarjeta.");
  expect(cerradas[1]).not.toContain("alta calidad");
  expect(r.id).toBe(100);
  expect(r.reply).toContain("La saco en alta calidad.");
  expect(r.reply).not.toContain("aquí está la tarjeta");
  expect(contestados).toEqual([[456]]);
});

test("folded: no parte, sólo da por contestado", { timeout: 30000 }, async () => {
  const { r, cerradas, contestados } = await correr([
    { type: "chunk", value: "Agregué el QR y aquí está." },
    { type: "reply_to", messageIds: ["452"], folded: true },
    { type: "done", value: "Agregué el QR y aquí está." },
  ]);
  expect(cerradas).toEqual({});
  expect(r.id).toBe(1);
  expect(contestados).toEqual([[452]]);
});

test("adjunto que no entró: aviso al pie, sin depender del modelo", { timeout: 30000 }, async () => {
  const { r } = await correr([
    { type: "attachments", failed: [{ name: "CARRUSEL1.png", reason: "fetch failed (ECONNRESET)" }] },
    { type: "chunk", value: "Veo una foto." },
    { type: "done", value: "Veo una foto." },
  ]);
  expect(r.reply).toContain("⚠️ No me llegó «CARRUSEL1.png» (fetch failed (ECONNRESET)). Vuelve a adjuntarlo.");
});

test("steer con adjunto fallido: el aviso vuelve con el INJECTED", { timeout: 30000 }, async () => {
  const { r } = await correr([
    { type: "attachments", failed: [{ name: "frida.jpg", reason: "HTTP 404" }] },
    { type: "injected" },
  ]);
  expect(r.id).toBe(0);
  expect(r.attachmentsFailed).toEqual([{ name: "frida.jpg", reason: "HTTP 404" }]);
});
