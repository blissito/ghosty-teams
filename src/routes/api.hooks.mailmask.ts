import { createFileRoute } from "@tanstack/react-router";

/**
 * MailMask → Teams: alguien CONTESTÓ por correo un correo de prospección.
 *
 * La campaña manda con `Reply-To` a una dirección de MailMask (p. ej. experts@ghosty.studio).
 * MailMask emite `email.received` a dos webhooks: gs abre el turno del agente y contesta en el
 * hilo; éste marca la fila «Contestó» (o la da de baja si escribió «BAJA»), igual que cuando
 * el prospecto escribe por WhatsApp (`api.hooks.whatsapp.$token.message`).
 *
 * El workspace sale del SUBDOMINIO de la URL registrada en MailMask
 * (`https://business.teams.ghosty.studio/api/hooks/mailmask`), como cualquier petición.
 * Env: `MAILMASK_WEBHOOK_SECRET` (el whsec_ de ESTE webhook; el de gs es otro).
 */
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const Route = createFileRoute("/api/hooks/mailmask")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const raw = await request.text();
        const { verifyMailmaskSignature, bareEmail } = await import("../server/mailmask-webhook");
        const ok = verifyMailmaskSignature(
          process.env.MAILMASK_WEBHOOK_SECRET ?? "",
          request.headers.get("x-mailmask-signature") ?? "",
          request.headers.get("x-mailmask-timestamp") ?? "",
          raw,
        );
        if (!ok) return json({ error: "bad_signature" }, 401);
        let ev: { event?: string; data?: { from?: string; subject?: string } };
        try {
          ev = JSON.parse(raw);
        } catch {
          return json({ error: "bad_request" }, 400);
        }
        if (ev.event === "ping") return json({ ok: true, pong: true });
        if (ev.event !== "email.received") return json({ ok: true, skipped: "evento" });
        const from = bareEmail(ev.data?.from);
        const { matchInboundEmail, recordReply } = await import("../server/prospeccion/inbound.server");
        // El cuerpo no viene en el evento: la baja por palabra se mira en el asunto («BAJA»);
        // la del cuerpo la atiende el agente, que tiene el texto completo.
        const m = await matchInboundEmail(from, String(ev.data?.subject ?? "").replace(/^(re|fw|fwd|rv)\s*:\s*/i, ""));
        if (!m) return json({ ok: true, matched: false });
        const { optedOut } = await recordReply(m);
        console.log(`[prospeccion] correo de ${from} → fila ${m.rowId} (${optedOut ? "baja" : "contestó"})`);
        return json({ ok: true, matched: true, optedOut });
      },
    },
  },
});
