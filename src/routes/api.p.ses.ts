import { createFileRoute } from "@tanstack/react-router";
import { createVerify, X509Certificate } from "node:crypto";

// POST /api/p/ses → notificaciones de SES por SNS: rebotes y quejas de los correos de
// prospección.
//
// Sin esto un correo a un buzón muerto se quedaba como «enviado», y a la siguiente campaña
// se le volvía a escribir; y una queja de spam —lo que de verdad hunde la reputación del
// dominio— no dejaba rastro. Cada correo sale con `X-SES-MESSAGE-TAGS: ns=<tenant>`, y ese
// tag vuelve aquí: es lo que dice en qué base buscar el toque por su MessageId.
//
// La firma de SNS se verifica de verdad (certificado de amazonaws.com + SHA1/SHA256 RSA):
// este endpoint es público, y sin firma cualquiera podría dar de baja a quien quisiera.
export const Route = createFileRoute("/api/p/ses")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const body = (await request.json().catch(() => null)) as Record<string, string> | null;
        if (!body || typeof body.Type !== "string") return new Response("bad request", { status: 400 });

        if (!(await verifySns(body))) return new Response("bad signature", { status: 403 });

        // Alta de la suscripción: SNS manda una URL que hay que visitar una vez.
        if (body.Type === "SubscriptionConfirmation" && body.SubscribeURL) {
          if (/^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com\//.test(body.SubscribeURL)) {
            await fetch(body.SubscribeURL).catch(() => {});
            console.log("[ses-events] suscripción confirmada");
          }
          return new Response("ok");
        }
        if (body.Type !== "Notification") return new Response("ok");

        let msg: SesEvent | null = null;
        try { msg = JSON.parse(body.Message) as SesEvent; } catch { return new Response("ok"); }
        const tipo = msg?.notificationType ?? msg?.eventType;
        if (tipo !== "Bounce" && tipo !== "Complaint") return new Response("ok");

        const ns = msg?.mail?.tags?.ns?.[0];
        const sesId = msg?.mail?.messageId;
        if (!ns || !sesId) return new Response("ok");

        try {
          const { withNamespace } = await import("../server/tenant.server");
          await withNamespace(ns, async () => {
            const { touchBySesId, markEvent } = await import("../server/prospeccion/touches.server");
            const { addOptOut } = await import("../server/prospeccion/optout.server");
            const touchId = await touchBySesId(sesId);
            const destinos =
              tipo === "Bounce"
                ? (msg!.bounce?.bouncedRecipients ?? []).map((r) => r.emailAddress)
                : (msg!.complaint?.complainedRecipients ?? []).map((r) => r.emailAddress);
            // Un rebote TRANSITORIO (buzón lleno, servidor caído) no es una baja: se
            // reintentaría solo en la siguiente campaña. El permanente y la queja, sí.
            const permanente = tipo === "Complaint" || msg!.bounce?.bounceType === "Permanent";
            if (permanente) {
              for (const e of destinos) await addOptOut("email", e, tipo === "Complaint" ? "complaint" : "bounce");
            }
            if (touchId != null && permanente) {
              const r = await markEvent(touchId, "bounced");
              if (r) {
                const { publish, ch } = await import("../server/bus.server");
                publish(ch.presence(ns), { t: "refresh", channelId: null, parentId: null });
              }
            }
            console.log(`[ses-events] ${tipo} ${permanente ? "permanente" : "transitorio"} · ${destinos.join(",")} · touch=${touchId ?? "?"}`);
          });
        } catch (e) {
          console.warn("[ses-events] no se pudo registrar:", (e as Error)?.message);
        }
        return new Response("ok");
      },
    },
  },
});

type SesEvent = {
  notificationType?: string;
  eventType?: string;
  mail?: { messageId?: string; tags?: Record<string, string[]> };
  bounce?: { bounceType?: string; bouncedRecipients?: { emailAddress: string }[] };
  complaint?: { complainedRecipients?: { emailAddress: string }[] };
};

/**
 * Verifica la firma de un mensaje de SNS.
 *
 * El certificado se baja de la URL que trae el mensaje, que TIENE que ser de amazonaws.com
 * (si no, cualquiera firmaría con su propio certificado). Se cachea: SNS rota muy poco.
 */
const certCache = new Map<string, string>();
async function verifySns(m: Record<string, string>): Promise<boolean> {
  try {
    const url = m.SigningCertURL ?? "";
    if (!/^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com\/.+\.pem$/.test(url)) return false;
    let pem = certCache.get(url);
    if (!pem) {
      pem = await (await fetch(url)).text();
      certCache.set(url, pem);
    }
    const campos =
      m.Type === "Notification"
        ? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
        : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
    const texto = campos.filter((k) => m[k] != null).map((k) => `${k}\n${m[k]}\n`).join("");
    const algo = m.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1";
    const v = createVerify(algo);
    v.update(texto, "utf8");
    return v.verify(new X509Certificate(pem).publicKey, m.Signature, "base64");
  } catch {
    return false;
  }
}
