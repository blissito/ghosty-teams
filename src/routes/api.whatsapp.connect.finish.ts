import { createFileRoute } from "@tanstack/react-router";

// GET /api/whatsapp/connect/finish?t=<token>&pairing=<id>&status=ok|error[&agent=<handle>]
//
// Vuelta del wizard de Formmy. Recoge el resultado de la sesión de pairing y guarda la
// fila del número. Formmy ya hizo el provision SERVER-SIDE (por eso vamos por sesión y no
// por el `code`: caduca en segundos y un popup que muere se llevaría el wizard entero).
//
// `t` es el token que emitió `start`: lleva firmados el tenant, el room y el
// `channelSecret`. Por eso no hace falta una tabla de pendientes — y por eso se VERIFICA
// antes de escribir nada.

const html = (title: string, msg: string, status = 200) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
      `<body style="font:16px/1.5 system-ui;padding:2rem;max-width:34rem">` +
      `<h1 style="font-size:1.25rem">${title}</h1><p>${msg}</p>` +
      `<p><a href="/">Volver a Ghosty Teams</a></p>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );

export const Route = createFileRoute("/api/whatsapp/connect/finish")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const url = new URL(request.url);
        const { verifyWaToken } = await import("../server/whatsapp/token.server");
        const ref = verifyWaToken(url.searchParams.get("t") || "");
        if (!ref) return html("Enlace inválido", "El enlace de conexión no es válido o fue alterado.", 400);

        if (url.searchParams.get("status") === "error") {
          const m = url.searchParams.get("message") || "Meta no completó la conexión.";
          return html("No se conectó", m, 400);
        }
        const pairingId = url.searchParams.get("pairing") || "";
        if (!pairingId) return html("Falta el pairing", "Formmy no devolvió la sesión de pairing.", 400);

        const { getPairingSession } = await import("../server/whatsapp/formmy-partner.server");
        let st: Awaited<ReturnType<typeof getPairingSession>>;
        try {
          st = await getPairingSession(pairingId);
        } catch (e) {
          return html("No se pudo confirmar", String(e).slice(0, 200), 502);
        }
        if (st.status !== "completed" || !st.integrationId) {
          // `pending` es legítimo: Formmy provisiona server-side y puede ir un instante
          // detrás del redirect. Se dice, y el usuario recarga.
          return html(
            st.status === "pending" ? "Casi listo" : "No se completó",
            st.status === "pending"
              ? "Formmy todavía está registrando el número. Recarga esta página en unos segundos."
              : st.error || `Estado: ${st.status}`,
            st.status === "pending" ? 202 : 400,
          );
        }

        // El ns viene FIRMADO en el token: entramos a ESE tenant. Sin esto,
        // `currentNamespace()` resolvería por el host y este endpoint funcionaría por
        // casualidad (el usuario sí llega desde su subdominio), pero dejaría el patrón
        // abierto a que el token y el host discrepen.
        const { withNamespace } = await import("../server/tenant.server");
        return withNamespace(ref.ns, async () => {
          const { ensureSchema } = await import("../server/schema.server");
          await ensureSchema();
          const { sessionUser } = await import("../server/chat");
          const me = await sessionUser();
          const { saveWaChannel } = await import("../server/whatsapp/channels.server");
          await saveWaChannel({
            integrationId: st.integrationId!,
            phone: (st.phoneNumber || "").replace(/[^\d]/g, ""),
            channelSecret: ref.channelSecret,
            roomId: ref.roomId,
            agentHandle: url.searchParams.get("agent"),
            // En nombre de quién trabajará el agente cuando escriba un desconocido. Es el
            // owner que conectó: un contacto de WhatsApp no tiene sesión, y sin un sub el
            // turno saldría sin conectores y sin nadie que pueda detenerlo.
            actingSub: me?.sub ?? null,
          });
          return html(
            "Número conectado",
            `WhatsApp <strong>${st.phoneNumber || ""}</strong> quedó conectado. ` +
              `Las conversaciones van a aparecer en el room que elegiste. ` +
              `Para que el número CONTESTE, enciéndelo en Formmy (<code>autoRespond</code>).`,
          );
        });
      },
    },
  },
});
