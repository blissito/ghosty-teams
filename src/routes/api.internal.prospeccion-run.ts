import { createFileRoute } from "@tanstack/react-router";
import crypto from "node:crypto";

// POST /api/internal/prospeccion-run?ts&sig  body { ns, sub, listId, key, limit? }
//
// Operación: vuelve a correr una columna del agente EN LA PANTALLA de la persona (publica el
// mismo evento de bus que usa `prospect_column` sobre una columna existente). Sirve para
// destrabar una lista sin pedirle a la persona que teclee «vuelve a correr Mensaje».
// Firmado con GHOSTY_PARTNER_SECRET: sig = HMAC(`${ts}.prospeccion-run`).
export const Route = createFileRoute("/api/internal/prospeccion-run")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const url = new URL(request.url);
        const ts = url.searchParams.get("ts") ?? "";
        const sig = url.searchParams.get("sig") ?? "";
        const secret = process.env.GHOSTY_PARTNER_SECRET;
        if (!secret) return new Response("no secret", { status: 500 });
        const expected = crypto.createHmac("sha256", secret).update(`${ts}.prospeccion-run`).digest("hex");
        if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
          return new Response("bad sig", { status: 403 });
        }
        if (Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) > 300) return new Response("stale", { status: 403 });
        const body = (await request.json().catch(() => null)) as { ns?: string; sub?: string; listId?: number; key?: string; limit?: number } | null;
        if (!body?.ns || !body.sub || !body.listId || !body.key) return new Response("bad request", { status: 400 });
        const { publish, ch } = await import("../server/bus.server");
        publish(ch.user(body.ns, body.sub), {
          t: "prospeccion:run",
          listId: Number(body.listId),
          key: body.key,
          limit: body.limit && body.limit > 0 ? Math.floor(body.limit) : null,
        });
        return Response.json({ ok: true });
      },
    },
  },
});
