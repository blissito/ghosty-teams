import { createFileRoute } from "@tanstack/react-router";

// GET /preview/:runId → la preview del pedido, para quien ve su room. Es la liga estable que viaja al PR,
// al hilo y a la tarjeta (SIN llave): aquí se pide la llave a gs en el momento y sólo va en el redirect,
// con no-store. Toda la lógica y su prueba: `server/apps/preview-open.server.ts`.
async function handle({ params, request }: { params: { runId: string }; request: Request }) {
  const { openPreview, PREVIEW_OPEN_HEADERS } = await import("../server/apps/preview-open.server");
  const { redeemPreviewTicket } = await import("../server/apps/preview-ticket");
  const { sessionUser } = await import("../server/chat");
  const db = await import("../db.server");
  const { dbq } = await import("../dbq.server");
  const R = await import("../server/apps/factory-runs.server");
  const r = await openPreview(params.runId, await sessionUser(), {
    runChannel: async (id) => {
      const [row] = await dbq("SELECT channel_id FROM gt_factory_runs WHERE id = ?", [id]).catch(() => []);
      return row ? Number(row.channel_id) : null;
    },
    getChannel: (id) => db.getChannelById(id),
    canSee: (ch, sub, isOwner) => db.canSeeChannel(ch as Awaited<ReturnType<typeof db.getChannelById>> & object, sub, isOwner),
    resolve: (id) => R.resolvePreviewUrl(id),
    redeemTicket: (id) => {
      const t = new URL(request.url).searchParams.get("t");
      const secret = process.env.SESSION_SECRET;
      return !!t && !!secret && redeemPreviewTicket(t, id, secret);
    },
  });
  if (r.status === 302) return new Response(null, { status: 302, headers: { ...PREVIEW_OPEN_HEADERS, Location: r.location } });
  return new Response(r.body, { status: r.status, headers: { ...PREVIEW_OPEN_HEADERS, "Content-Type": "text/plain; charset=utf-8" } });
}

export const Route = createFileRoute("/preview/$runId")({
  server: { handlers: { GET: handle } },
});
