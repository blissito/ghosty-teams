import { createFileRoute } from "@tanstack/react-router";

// ── Endpoint interno: una tarea de Tasks asignada a @plan ──────────────────────
//
// Tasks lo llama cuando alguien asigna una tarea a `@plan` (el agente de la Software
// Factory). Aquí se abre la corrida: el pedido se publica en el room de la fábrica y se
// despierta a @plan en ese hilo (`startRunFromTask`).
//
// Firma de partner sobre el CUERPO en crudo (`ts.<rawBody>`), como `api/internal/board-event`.
// El namespace lo resuelve el HOST ({slug}.teams…), igual que ahí.

async function verify(ts: string, sig: string, rawBody: string): Promise<boolean> {
  const crypto = await import("node:crypto");
  const secret = process.env.GHOSTY_PARTNER_SECRET;
  if (!secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) <= 300;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export const Route = createFileRoute("/api/internal/factory-task")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const raw = await request.text();
        const ok = await verify(request.headers.get("x-ghosty-ts") ?? "", request.headers.get("x-ghosty-sig") ?? "", raw);
        if (!ok) return new Response("firma inválida", { status: 403 });

        let ev: { taskRef?: unknown; title?: unknown; description?: unknown; requestedBy?: unknown };
        try {
          ev = JSON.parse(raw);
        } catch {
          return new Response("json inválido", { status: 400 });
        }
        const taskRef = String(ev.taskRef ?? "").trim().slice(0, 40);
        const requestedBy = String(ev.requestedBy ?? "").trim();
        if (!taskRef || !requestedBy) return json({ ok: false, error: "faltan taskRef o requestedBy" }, 400);

        const { ensureSchema } = await import("../server/schema.server");
        await ensureSchema();
        const { reqOrigin } = await import("../origin.server");
        const origin = await reqOrigin().catch(() => "");
        const { startRunFromTask } = await import("../server/apps/factory-runs.server");
        const r = await startRunFromTask({
          taskRef,
          title: String(ev.title ?? ""),
          description: String(ev.description ?? ""),
          requestedBy,
          origin,
        });
        if ("error" in r) return json({ ok: false, error: r.error }, 404);
        return json({ ok: true, ...r });
      },
    },
  },
});
