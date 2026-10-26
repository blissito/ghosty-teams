import { createFileRoute } from "@tanstack/react-router";

// ── Endpoint interno: gs despierta al agente cuando un encargo terminó ──────────
//
// Lo llama gs en el callback de un `VideoRun` (montaje o audio de YouTube). El cuerpo trae
// el `ref` que ESTE tenant le dio al abrir el turno (`mintWakeRef`): gs no elige a quién ni
// dónde, sólo devuelve la capacidad. Idempotente por `key`: gs puede reintentar.
//
// Firma de partner sobre el CUERPO en crudo (`ts.<rawBody>`), como `api/internal/alert`.
// El namespace lo resuelve el HOST, como todo lo demás.

export const Route = createFileRoute("/api/internal/agent-wake")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const raw = await request.text();
        const ok = (await import("../server/partner-sig.server")).partnerRequestOk(request, raw);
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
          // `reqOrigin`, no `request.url`: tras el proxy llega en http y el 308 tira el Authorization.
          origin: await (await import("../origin.server")).reqOrigin(),
        });
        return Response.json({ ok: true, queued: nuevo });
      },
    },
  },
});
