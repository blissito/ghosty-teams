import { createFileRoute } from "@tanstack/react-router";

// ── Endpoint interno: gs despierta al agente cuando un encargo terminó ──────────
//
// Lo llama gs en el callback de un `VideoRun` (montaje o audio de YouTube). El cuerpo trae
// el `ref` que ESTE tenant le dio al abrir el turno (`mintWakeRef`): gs no elige a quién ni
// dónde, sólo devuelve la capacidad. Idempotente por `key`: gs puede reintentar.
//
// Firma de partner sobre el CUERPO en crudo (`ts.<rawBody>`), como `api/internal/alert`.
// El namespace lo resuelve el HOST, como todo lo demás.

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

export const Route = createFileRoute("/api/internal/agent-wake")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const raw = await request.text();
        const ok = await verify(
          request.headers.get("x-ghosty-ts") ?? "",
          request.headers.get("x-ghosty-sig") ?? "",
          raw,
        );
        if (!ok) return new Response("firma inválida", { status: 403 });

        let body: { ref?: string; key?: string; cause?: string; text?: string };
        try {
          body = JSON.parse(raw) as typeof body;
        } catch {
          return new Response("json inválido", { status: 400 });
        }
        if (!body.ref || !body.key || !body.text) return new Response("faltan ref, key o text", { status: 400 });

        await (await import("../server/schema.server")).ensureSchema().catch(() => {});
        const { verifyWakeRef, enqueueWakeup } = await import("../server/wakeups.server");
        const ref = verifyWakeRef(body.ref);
        if (!ref) return new Response("ref inválido", { status: 403 });
        // El ref lleva su ns: tiene que ser el de ESTE host, o un ref de un workspace
        // despertaría al agente en otro.
        const { currentNamespace } = await import("../server/tenant.server");
        if (ref.ns !== (await currentNamespace())) return new Response("ref de otro workspace", { status: 403 });

        const nuevo = await enqueueWakeup({
          key: String(body.key).slice(0, 200),
          ref: body.ref,
          cause: String(body.cause ?? "evento").slice(0, 60),
          text: String(body.text).slice(0, 4000),
          origin: new URL(request.url).origin,
        });
        return Response.json({ ok: true, queued: nuevo });
      },
    },
  },
});
