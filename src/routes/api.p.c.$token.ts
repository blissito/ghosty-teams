import { createFileRoute } from "@tanstack/react-router";

// GET /api/p/c/<token> → registra el clic y redirige al destino real.
//
// ⚠️ El destino va DENTRO del token firmado, nunca como query param. Con `?url=` esto sería
// un redirector abierto: cualquiera podría mandar `nuestrodominio.com/api/p/c/?url=<phishing>`
// y llevarse nuestra reputación de dominio por delante. Firmado, sólo redirige a donde
// nosotros pusimos al armar el correo.
//
// Un clic es la señal que vuelve TIBIO a un prospecto: es lo que autoriza el paso a
// WhatsApp. Por eso se registra antes de redirigir, aunque cueste unos milisegundos.
export const Route = createFileRoute("/api/p/c/$token")({
  server: {
    handlers: {
      GET: async ({ params }: { params: { token: string } }) => {
        const { verifyTrackToken, publicOrigin } = await import("../server/prospeccion/track.server");
        const c = verifyTrackToken(params.token || "");

        // Token inválido → a la raíz, no a un error. Quien llega aquí es el prospecto.
        if (!c || c.kind !== "click" || !c.url) {
          return new Response(null, { status: 302, headers: { Location: publicOrigin() } });
        }

        try {
          const { withNamespace } = await import("../server/tenant.server");
          await withNamespace(c.ns, async () => {
            const { markEvent } = await import("../server/prospeccion/touches.server");
            const r = await markEvent(c.touchId, "clicked");
            if (r) {
              const { publish, ch } = await import("../server/bus.server");
              publish(ch.presence(c.ns), { t: "refresh", channelId: null, parentId: null });
            }
          });
        } catch {
          // Si no se pudo registrar, el prospecto igual llega a donde iba.
        }

        return new Response(null, { status: 302, headers: { Location: c.url } });
      },
    },
  },
});
