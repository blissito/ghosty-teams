import { createFileRoute } from "@tanstack/react-router";

// ── Endpoint interno: publica un aviso de operación en el room de soporte ────
//
// Lo llama gs (`alert.server.ts`) cuando algo se rompe. El aviso aterriza donde
// la gente ya está mirando, en vez de en el journal de una caja.
//
// ⚠️ Esto NO sirve para avisar de una caída: si Teams está muerto, este canal
// también. Las caídas van por WhatsApp desde gs, que es el único camino que no
// pasa por aquí. Aquí llegan los incidentes de aplicación.
//
// El namespace lo resuelve el HOST de la petición (`<slug>.teams.ghosty.studio`),
// como todo lo demás: por eso el slug NO va en la firma ni en el cuerpo — meterlo
// invitaría a creerle al parámetro en vez de al enrutamiento.

/** Room donde aterrizan los avisos. `soporte` existe en TODO workspace: lo
 *  siembra `createWorkspace` junto con general y random. */
const ROOM = "soporte";

async function verify(ts: string, sig: string, rawBody: string): Promise<boolean> {
  const crypto = await import("node:crypto");
  const secret = process.env.GHOSTY_PARTNER_SECRET;
  if (!secret) return false;
  // Se firma el CUERPO en crudo, no un literal: un aviso es contenido que se
  // publica en un room, así que la firma tiene que cubrir lo que se va a
  // publicar. Con `ts.<recurso>` bastaría capturar UNA firma válida para poder
  // publicar cualquier texto durante cinco minutos.
  const expected = crypto.createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) <= 300;
}

export const Route = createFileRoute("/api/internal/alert")({
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

        const { title, detail } = JSON.parse(raw) as { title?: string; detail?: string };
        if (!title) return new Response("falta title", { status: 400 });

        await (await import("../server/schema.server")).ensureSchema().catch(() => {});
        const db = await import("../db.server");
        const room = await db.getChannel(ROOM);
        if (!room) return Response.json({ ok: false, error: `no existe #${ROOM}` }, { status: 404 });

        const body = detail ? `**${title}**\n\n\`\`\`\n${detail.slice(0, 1500)}\n\`\`\`` : `**${title}**`;
        const { id } = await db.createMessage({
          channelId: room.id,
          parentId: null,
          sender: "Ghosty",
          // `senderSub: null` = evento de sistema, igual que el rastro de una
          // llamada. Un aviso no lo escribió ninguna persona y atribuírselo a
          // una haría que su nombre apareciera avisando de caídas.
          senderSub: null,
          body,
          topic: "general",
        });

        // El evento va por el bus para que aparezca en las pestañas abiertas sin
        // recargar. Aquí `message:new` SÍ es lo correcto —es un mensaje de
        // verdad y queremos que se note— al revés que los eventos que sólo
        // refrescan estado.
        const bus = await import("../server/bus.server");
        const { currentNamespace } = await import("../server/tenant.server");
        const creado = await db.getMessage(id);
        if (creado) bus.publish(bus.ch.room(await currentNamespace(), room.id), { t: "message:new", msg: creado });

        return Response.json({ ok: true, messageId: id });
      },
    },
  },
});
