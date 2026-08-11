import { createFileRoute } from "@tanstack/react-router";

// GET /api/whatsapp/connect/start?room=<slug>[&agent=<handle>]
//
// Arranca la conexión de un número de WhatsApp Business. Redirige al wizard de Embedded
// Signup que hospeda Formmy y vuelve a `/api/whatsapp/connect/finish`.
//
// Lo que se decide AQUÍ y viaja firmado en el token de la URL de entrega: el tenant y el
// room donde va a aterrizar la conversación. Formmy nunca los recibe como parámetro
// manipulable — sólo ve una URL opaca a la que postear.
//
// El `channelSecret` lo generamos nosotros y lo propagamos a Formmy, que lo guarda como
// `Integration.externalAgentSecret`. Autentica en los DOS sentidos.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export const Route = createFileRoute("/api/whatsapp/connect/start")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const { sessionUser } = await import("../server/chat");
        const me = await sessionUser();
        // Conectar un número es config del WORKSPACE y cuesta dinero real en el WABA del
        // cliente: sólo el owner.
        if (!me?.isOwner) return json({ error: "solo el owner puede conectar un número" }, 403);

        const url = new URL(request.url);
        const slug = url.searchParams.get("room") || "";
        const agent = url.searchParams.get("agent") || null;
        if (!slug) return json({ error: "falta ?room=<slug>" }, 400);

        const { ensureSchema } = await import("../server/schema.server");
        await ensureSchema();
        const db = await import("../db.server");
        const room = await db.getChannel(slug);
        if (!room) return json({ error: "room no encontrado" }, 404);

        const { currentNamespace } = await import("../server/tenant.server");
        const ns = await currentNamespace();

        const { generateChannelSecret, createPairingSession } = await import(
          "../server/whatsapp/formmy-partner.server"
        );
        const { mintWaToken } = await import("../server/whatsapp/token.server");
        const { buildPartnerPopupUrl, requestOrigin } = await import(
          "../server/whatsapp/popup.server"
        );

        const channelSecret = generateChannelSecret();
        const token = mintWaToken({ ns, roomId: room.id, topic: "general", channelSecret });
        const origin = requestOrigin(request);

        // Formmy le pega `/message` al final de esto al entregar.
        const externalAgentUrl = `${origin}/api/hooks/whatsapp/${token}`;
        // El token viaja también en la vuelta: así `finish` sabe a qué room pertenece el
        // pairing sin una tabla de pendientes. Formmy preserva nuestros query params y le
        // agrega `pairing` y `status` (ver `handoff` en su `partners.connect.tsx`).
        const returnUrl = `${origin}/api/whatsapp/connect/finish?t=${encodeURIComponent(token)}${
          agent ? `&agent=${encodeURIComponent(agent)}` : ""
        }`;

        // Formmy usa el correo sólo para identificar la integración en su panel. No viene en
        // la sesión (que lleva sub/name/avatar), así que se lee de `gc_users`.
        const { dbq } = await import("../dbq.server");
        const emailRows = await dbq("SELECT email FROM gc_users WHERE sub = ?", [me.sub]).catch(
          () => [],
        );
        const email = emailRows[0]?.email ?? "";

        let pairingId: string;
        try {
          pairingId = await createPairingSession({
            externalAgentUrl,
            channelSecret,
            email,
            denikOrgId: ns,
          });
        } catch (e) {
          // El fallo típico es el env sin poner: decirlo, en vez de un 500 mudo.
          return json({ error: "no se pudo iniciar el pairing", details: String(e).slice(0, 200) }, 502);
        }

        return new Response(null, {
          status: 302,
          headers: { Location: buildPartnerPopupUrl(request, { pairingId, returnUrl }) },
        });
      },
    },
  },
});
