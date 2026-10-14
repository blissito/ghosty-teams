import { createFileRoute } from "@tanstack/react-router";

// ── Endpoint interno: decidir un pedido de la fábrica sin la tarjeta ─────────────
//
// Lo mismo que «Otra vuelta» / «Replanear» de la tarjeta (`factoryDecisionFn`), para staff desde
// gs (13-oct: #74/#75 de business escalados por la caja de CI y nadie con el navegador a mano).
// Firma a nombre de quien ya aprobó el plan (`approved_by`) si no se manda `sub`: sus
// credenciales de GitHub son con las que @build sigue trabajando.
//
// Firma de partner sobre el CUERPO en crudo (`ts.<rawBody>`), como `api/internal/agent-wake`.
// El namespace lo resuelve el HOST.

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

export const Route = createFileRoute("/api/internal/factory-decide")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const raw = await request.text();
        const ok = await verify(request.headers.get("x-ghosty-ts") ?? "", request.headers.get("x-ghosty-sig") ?? "", raw);
        if (!ok) return new Response("firma inválida", { status: 403 });

        let body: { runId?: number; decision?: string; note?: string; sub?: string; who?: string };
        try {
          body = JSON.parse(raw) as typeof body;
        } catch {
          return new Response("json inválido", { status: 400 });
        }
        const R = await import("../server/apps/factory-runs.server");
        const run = await R.getRun(Number(body.runId));
        if (!run) return Response.json({ error: "pedido no encontrado" }, { status: 404 });
        const sub = body.sub || run.approvedBy || run.requestedBy;
        if (!sub) return Response.json({ error: "sin sub" }, { status: 400 });
        try {
          const next = await R.decide({
            run,
            version: run.planVersion,
            decision: body.decision === "changes" ? "changes" : "approve",
            note: body.note,
            sub,
            who: String(body.who || "staff de Ghosty").slice(0, 80),
            origin: await (await import("../origin.server")).reqOrigin().catch(() => ""),
          });
          return Response.json({ ok: true, status: next.status });
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 409 });
        }
      },
    },
  },
});
