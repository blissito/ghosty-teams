import { createFileRoute } from "@tanstack/react-router";

// ── Puente EasyBits Forms → room ────────────────────────────────────────────
// EasyBits dispara `form.submitted` (firmado HMAC) cuando alguien responde un
// formulario hospedado. Aquí verificamos la firma, resolvemos form_id → canal
// vía gc_expediente_forms, y dejamos la respuesta como mensaje del bot en el room
// (el expediente del cliente). Auth = HMAC (no sesión). Persist-then-publish.

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

function renderBody(formName: string, fields: EbField[], data: Record<string, string>): string {
  const lines = fields.map((f) => `• **${f.label}**: ${renderValue(f, data[f.name] || "")}`);
  return `📋 **Nueva respuesta — ${formName}**\n\n${lines.join("\n")}`;
}

export const Route = createFileRoute("/api/webhook/easybits")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        // Raw body FIRST (single-use) — HMAC se computa sobre los bytes exactos.
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
        // El engine de EasyBits envuelve: { event, timestamp, data }.
        const event = payload?.event;
        const p = payload?.data ?? {};
        if (event !== "form.submitted") return Response.json({ ok: true, ignored: event ?? "no-event" });

        const formId: string | undefined = p.formId;
        const formName: string = p.formName ?? "Formulario";
        const fields: EbField[] = Array.isArray(p.fields) ? p.fields : [];
        const data: Record<string, string> = p.data ?? {};
        if (!formId) return Response.json({ ok: true, ignored: "no-formId" });

        const { ensureSchema } = await import("../server/schema.server");
        await ensureSchema();
        const { dbq, num } = await import("../dbq.server");

        // form_id → canal del expediente. Sin mapeo → no-op (una webhook por cuenta
        // hace fan-out a varios rooms; los forms no mapeados a este team se ignoran).
        const rows = await dbq("SELECT channel_id, form_key FROM gc_expediente_forms WHERE form_id = ?", [formId]);
        if (!rows[0]) return Response.json({ ok: true, ignored: "unmapped" });
        const channelId = num(rows[0].channel_id);
        const topic = (rows[0].form_key ?? "expediente") || "expediente";

        const body = fields.length
          ? renderBody(formName, fields, data)
          : `📋 **Nueva respuesta — ${formName}**\n\n${Object.entries(data).map(([k, v]) => `• **${k}**: ${v}`).join("\n")}`;

        const { postAgent, getMessage, attachArtifacts } = await import("../db.server");
        const { id: msgId } = await postAgent(channelId, null, body, "msg", "easybits", "EasyBits Forms", topic, "");

        await dbq(
          "UPDATE gc_expediente_forms SET submission_count = submission_count + 1, last_submitted_at = unixepoch() WHERE form_id = ?",
          [formId]
        );

        // Persist done → publica la señal realtime al room.
        const msg = await getMessage(msgId);
        if (msg) {
          const [withMeta] = await attachArtifacts([msg]);
          const bus = await import("../server/bus.server");
          bus.publish(bus.ch.room(channelId), { t: "message:new", msg: withMeta });
        }

        return Response.json({ ok: true, messageId: msgId });
      },
    },
  },
});
