import { createFileRoute } from "@tanstack/react-router";

// ── Endpoint interno: avisos de un tablero de ventas de gs ──────────────────────
//
// gs (`board-events.server.ts`) lo llama cuando llega un lead nuevo o una tarjeta cambia de
// columna. Aquí se reparte a los rooms que siguen ESE tablero (gt_room_sales_boards). Sólo
// nombre, folio y columna: es lo que ve todo el room; el detalle se abre con el acceso de
// cada quien en sales.ghosty.studio.
//
// Firma de partner sobre el CUERPO en crudo (`ts.<rawBody>`), como `api/internal/alert`. El
// namespace lo resuelve el HOST.

type BoardEvent = {
  kind: "lead" | "stage";
  boardId: string;
  tablero: string;
  url: string;
  folio: number | null;
  nombre: string;
  canal?: string | null;
  de?: string | null;
  a?: string | null;
};

const CANAL: Record<string, string> = { messenger: "Messenger", whatsapp: "WhatsApp", wa: "WhatsApp" };

function bodyOf(ev: BoardEvent): string {
  const quien = `${ev.folio ? `#${ev.folio} ` : ""}${ev.nombre}`.trim();
  if (ev.kind === "lead") {
    const por = ev.canal ? ` por ${CANAL[ev.canal] ?? ev.canal}` : "";
    return `🆕 Lead nuevo${por} en **${ev.tablero}**: [${quien}](${ev.url})`;
  }
  return `➡️ [${quien}](${ev.url}) pasó a **${ev.a ?? "sin columna"}**${ev.de ? ` (antes ${ev.de})` : ""} · ${ev.tablero}`;
}

export const Route = createFileRoute("/api/internal/board-event")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const raw = await request.text();
        const ok = (await import("../server/partner-sig.server")).partnerRequestOk(request, raw);
        if (!ok) return new Response("firma inválida", { status: 403 });

        let ev: BoardEvent;
        try {
          ev = JSON.parse(raw) as BoardEvent;
        } catch {
          return new Response("json inválido", { status: 400 });
        }
        if (!ev.boardId || (ev.kind !== "lead" && ev.kind !== "stage")) return new Response("evento inválido", { status: 400 });

        await (await import("../server/schema.server")).ensureSchema().catch(() => {});
        const db = await import("../db.server");
        const rooms = await db.roomsOfSalesBoard(String(ev.boardId));
        if (!rooms.length) return Response.json({ ok: true, rooms: 0 });

        const bus = await import("../server/bus.server");
        const { currentNamespace } = await import("../server/tenant.server");
        const ns = await currentNamespace();
        const body = bodyOf(ev);
        for (const channelId of rooms) {
          const { id } = await db.createMessage({
            channelId,
            parentId: null,
            sender: "Ventas",
            // Evento de sistema: no lo escribió nadie.
            senderSub: null,
            body,
            topic: "general",
          });
          const creado = await db.getMessage(id);
          if (creado) bus.publish(bus.ch.room(ns, channelId), { t: "message:new", msg: creado });
        }
        return Response.json({ ok: true, rooms: rooms.length });
      },
    },
  },
});
