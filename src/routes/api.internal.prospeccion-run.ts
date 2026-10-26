import { createFileRoute } from "@tanstack/react-router";

// POST /api/internal/prospeccion-run  body { ns, sub, listId, key, limit? }
//
// Operación: vuelve a correr una columna del agente EN LA PANTALLA de la persona (publica el
// mismo evento de bus que usa `prospect_column` sobre una columna existente). Sirve para
// destrabar una lista sin pedirle a la persona que teclee «vuelve a correr Mensaje».
// Firma de partner en headers sobre el cuerpo (`partner-sig.server`): el `ns`/`sub` vienen del
// cuerpo, así que la firma tiene que cubrirlo (con el literal viejo una firma capturada servía
// para publicar en el bus de CUALQUIER espacio durante 5 min). ⚠️ Transición: el formato viejo
// `?ts&sig` sobre `${ts}.prospeccion-run` se acepta hasta que se borre.
export const Route = createFileRoute("/api/internal/prospeccion-run")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const raw = await request.text();
        const S = await import("../server/partner-sig.server");
        if (!S.partnerRequestOk(request, raw) && !S.legacyLiteralOk(request, "prospeccion-run")) {
          return new Response("firma inválida", { status: 403 });
        }
        const body = (() => { try { return JSON.parse(raw); } catch { return null; } })() as { ns?: string; sub?: string; listId?: number; key?: string; limit?: number } | null;
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
