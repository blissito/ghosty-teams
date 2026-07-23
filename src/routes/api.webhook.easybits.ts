import { createFileRoute } from "@tanstack/react-router";

// ── Puente EasyBits Forms → room ────────────────────────────────────────────
// EasyBits dispara `form.submitted` (firmado HMAC) cuando alguien responde un
// formulario hospedado. Aquí verificamos la firma, resolvemos form_id → canal
// vía gc_expediente_forms, y dejamos la respuesta en el room como una CARD
// compacta + un ARTEFACTO documento (visor + Descargar PDF/Word) — NO un blob de
// texto. La ficha es un Documento EasyBits real creado en el submit; aquí solo la
// adjuntamos reusando el loop de artefacto (mintCollabEmbed + createArtifact).
// Auth = HMAC (no sesión). Persist-then-publish.

type EbField = { name: string; label: string; type: string; options?: string[]; rows?: string[] };

function renderValue(field: EbField, value: string): string {
  if (field.type === "matrix") {
    let sel: Record<string, string> = {};
    try { sel = value ? JSON.parse(value) : {}; } catch { sel = {}; }
    const answered = (field.rows || []).filter((r) => sel[r]);
    if (!answered.length) return "_(sin responder)_";
    return answered.map((r) => `${r}: **${sel[r]}**`).join("; ");
  }
  if (field.type === "checkbox") return value === "true" ? "Sí" : "—";
  if (field.type === "file") return value ? "📎 archivo adjunto" : "—";
  return value || "—";
}

// Fallback SOLO si no hay ficha-documento: resumen legible (no el blob).
function renderFallback(formName: string, fields: EbField[], data: Record<string, string>): string {
  const lines = fields.slice(0, 8).map((f) => `• **${f.label}**: ${renderValue(f, data[f.name] || "")}`);
  const more = fields.length > 8 ? `\n_…y ${fields.length - 8} campos más._` : "";
  return `📋 **Nueva respuesta — ${formName}**\n\n${lines.join("\n")}${more}`;
}

export const Route = createFileRoute("/api/webhook/easybits")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const raw = await request.text();
        const sig = request.headers.get("x-easybits-signature") ?? "";
        const secret = process.env.EASYBITS_WEBHOOK_SECRET;
        if (!secret) return new Response("not configured", { status: 500 });

        const crypto = await import("node:crypto");
        const expected = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
        const a = Buffer.from(expected);
        const b = Buffer.from(sig);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
          return new Response("bad signature", { status: 401 });
        }

        let payload: any;
        try { payload = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }
        const event = payload?.event;
        const p = payload?.data ?? {};
        if (event !== "form.submitted") return Response.json({ ok: true, ignored: event ?? "no-event" });

        const formId: string | undefined = p.formId;
        const formName: string = p.formName ?? "Formulario";
        const fields: EbField[] = Array.isArray(p.fields) ? p.fields : [];
        const data: Record<string, string> = p.data ?? {};
        const fichaDocumentId: string | null = p.fichaDocumentId ?? null;
        if (!formId) return Response.json({ ok: true, ignored: "no-formId" });

        const { ensureSchema } = await import("../server/schema.server");
        await ensureSchema();
        const { dbq, num } = await import("../dbq.server");

        const rows = await dbq("SELECT channel_id, form_key FROM gc_expediente_forms WHERE form_id = ?", [formId]);
        if (!rows[0]) return Response.json({ ok: true, ignored: "unmapped" });
        const channelId = num(rows[0].channel_id);
        const topic = (rows[0].form_key ?? "expediente") || "expediente";

        // Card compacta (la data completa vive en el artefacto-documento).
        const empresa = data.razon_social || data.empresa || data.nombre || data.contacto || "";
        const { mintCollabEmbed } = await import("../server/easybits-documents.server");
        const embed = fichaDocumentId ? await mintCollabEmbed({ documentId: fichaDocumentId }) : null;

        const body = embed
          ? `📋 **Nueva respuesta de intake**${empresa ? ` — **${empresa}**` : ""}\n_${formName}_ · abre la ficha para ver todo y descargar PDF/Word.`
          : renderFallback(formName, fields, data);

        const { postAgent, getMessage, createArtifact, attachArtifacts } = await import("../db.server");
        const { id: msgId } = await postAgent(channelId, null, body, "msg", "easybits", "EasyBits Forms", topic, "");

        if (embed) {
          await createArtifact(msgId, {
            kind: "html",
            url: embed.embedUrl,
            title: embed.title || `Ficha — ${empresa || formName}`,
          });
        }

        await dbq(
          "UPDATE gc_expediente_forms SET submission_count = submission_count + 1, last_submitted_at = unixepoch() WHERE form_id = ?",
          [formId]
        );

        const msg = await getMessage(msgId);
        if (msg) {
          const [withMeta] = await attachArtifacts([msg]);
          const bus = await import("../server/bus.server");
          // Mismo ns que resolvió dbq para escribir el mensaje (el handler ya opera
          // dentro de este tenant): así el publish realtime cae en el workspace correcto.
          const { currentNamespace } = await import("../server/tenant.server");
          const ns = await currentNamespace();
          bus.publish(bus.ch.room(ns, channelId), { t: "message:new", msg: withMeta });
        }

        return Response.json({ ok: true, messageId: msgId, artifact: !!embed });
      },
    },
  },
});
