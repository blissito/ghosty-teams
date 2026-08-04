import { createFileRoute } from "@tanstack/react-router";

// POST /api/form/<token> → una respuesta a un formulario nativo.
//
// Lo llama el navegador de quien responde, DIRECTO. No hay servicio intermedio, así que no
// hay firma entre servicios que verificar ni entregas que un tercero pueda perder — que es
// exactamente lo que fallaba en el puente a EasyBits Forms que esto reemplaza (un único
// secreto global, el tenant adivinado por subdominio, cero reintentos, cero idempotencia).
//
// El token NO autentica a nadie: va dentro del HTML de un formulario público. Su trabajo es
// transportar el NAMESPACE del tenant sin que se pueda manipular, porque el formulario se
// abre desde el host de artefactos y desde un iframe de origen OPACO, donde el subdominio no
// identifica al workspace.
//
// CORS `*` y sin credenciales: el iframe tiene CSP `sandbox` sin `allow-same-origin`, así
// que su header `Origin` es literalmente "null" y no manda cookies. No hay nada que
// proteger con CORS aquí (el formulario es público por definición y el endpoint no lee
// sesión); `null` no identifica a nadie, así que ni allowlist ni eco del Origin.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Cache-Control": "no-store",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

export const Route = createFileRoute("/api/form/$token")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),

      POST: async ({ params, request }: { params: { token: string }; request: Request }) => {
        const { verifyFormToken } = await import("../server/forms/token.server");
        const ref = verifyFormToken(params.token);
        // Un token inválido responde 404, no 401: no hay por qué confirmar que el
        // formulario existe a quien está probando tokens.
        if (!ref) return json({ ok: false, error: "no encontrado" }, 404);

        let payload: { _idem?: string; _hp?: string; _draft?: string; data?: Record<string, unknown> };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return json({ ok: false, error: "cuerpo inválido" }, 400);
        }

        // Trampa para bots: responde como si todo hubiera salido bien y no guarda nada.
        // Decirle al bot que lo detectamos sólo le enseña a evitarlo.
        if (payload._hp) return json({ ok: true });

        const { withNamespace } = await import("../server/tenant.server");
        return withNamespace(ref.ns, async () => {
          const { ensureSchema } = await import("../server/schema.server");
          await ensureSchema();

          const { getForm } = await import("../server/forms/publish.server");
          const form = await getForm(ref.id);
          // `ns` del token contra `ns` de la fila: defensa en profundidad si un formulario
          // se moviera de tenant alguna vez.
          if (!form || form.ns !== ref.ns) return json({ ok: false, error: "no encontrado" }, 404);
          // El idioma sale de la FILA, no del request: quien responde llega sin cookie y
          // desde un origen opaco. Es el mismo que se horneó en el HTML que está viendo.
          const { formStrings } = await import("../lib/form-strings");
          const s = formStrings(form.locale);

          if (form.status === "closed") {
            return json({ ok: false, errors: { _form: s.formClosed } }, 200);
          }

          const { clientIp, rateCheck } = await import("../server/forms/rate.server");
          const ip = clientIp(request);
          const { ipHash, allowed } = await rateCheck(form.id, ip);
          if (!allowed) {
            return json({ ok: false, errors: { _form: s.rateLimited } }, 429);
          }

          const { validateSubmission } = await import("../lib/form-fields");
          const v = validateSubmission(form.fields, payload.data ?? {}, form.locale);
          if (!v.ok) return json({ ok: false, errors: v.errors }, 400);

          // Los archivos se subieron antes (api.form-upload); en los datos sólo viaja el
          // fileId, y su metadata se resuelve aquí para la ficha.
          const files = await resolveFiles(form.fields, v.cleanData);

          const idem = String(payload._idem ?? "").slice(0, 80) || null;
          const { dbq, num } = await import("../dbq.server");
          // La clave de idempotencia se acota al formulario: dos formularios distintos
          // pueden generar el mismo uuid sin estorbarse (y el índice es único global).
          const idemKey = idem ? `${form.id}:${idem}` : null;

          const inserted = await dbq(
            `INSERT INTO gt_form_submissions (form_id, ip_hash, data_json, files_json, idem_key)
             VALUES (?,?,?,?,?)
             ON CONFLICT(idem_key) DO NOTHING
             RETURNING id`,
            [form.id, ipHash, JSON.stringify(v.cleanData), JSON.stringify(files), idemKey]
          );

          // El borrador se borra en cuanto la respuesta está guardada, y también en el
          // camino del duplicado: si el primer intento entró y el segundo llega por un
          // reintento de red, dejarlo vivo mantendría un enlace que enseña el intake de esa
          // persona. Falla en silencio a propósito — es limpieza, no parte del envío.
          if (payload._draft) {
            try {
              const { verifyDraftToken } = await import("../server/forms/token.server");
              const d = verifyDraftToken(payload._draft);
              if (d && d.formId === form.id && d.ns === ref.ns) {
                const { dbq: q } = await import("../dbq.server");
                await q(`DELETE FROM gt_form_drafts WHERE draft_id = ? AND form_id = ?`, [d.draftId, form.id]);
              }
            } catch (e) {
              console.error("[form submit] borrar el borrador falló", e);
            }
          }

          // Sin fila = ya existía esa misma respuesta (doble clic, reintento de red). Se
          // contesta bien y NO se vuelve a postear: una respuesta, una ficha.
          if (!inserted[0]) return json({ ok: true, duplicate: true });

          const submissionId = num(inserted[0].id);
          try {
            const { deliverSubmission } = await import("../server/forms/deliver.server");
            await deliverSubmission({ form, submissionId, data: v.cleanData, files });
          } catch (e) {
            // La respuesta YA está guardada. Decirle "falló" a quien acaba de llenar el
            // formulario sería mentirle y provocar un reenvío; el hueco en el room se
            // arregla del lado nuestro.
            console.error("[form submit] entrega al room falló", e);
          }

          return json({ ok: true });
        });
      },
    },
  },
});

/** fileId → metadata guardada al subir, para poder nombrar el archivo en la ficha. */
async function resolveFiles(
  fields: import("../lib/form-fields").FormField[],
  data: Record<string, string>
): Promise<Record<string, { fileId: string; name?: string; mime?: string; size?: number }>> {
  const names = fields.filter((f) => f.type === "file" && data[f.name]).map((f) => f.name);
  if (!names.length) return {};
  const out: Record<string, { fileId: string; name?: string; mime?: string; size?: number }> = {};
  const { dbq, num } = await import("../dbq.server");
  for (const n of names) {
    const fileId = data[n];
    try {
      // La metadata la escribió el endpoint de upload (gt_form_files). No se le cree al
      // cliente: el nombre del archivo acaba impreso en la ficha del expediente.
      const rows = await dbq("SELECT name, mime, size FROM gt_form_files WHERE file_id = ? LIMIT 1", [fileId]);
      out[n] = rows[0]
        ? { fileId, name: rows[0].name ?? undefined, mime: rows[0].mime ?? undefined, size: num(rows[0].size) }
        : { fileId };
    } catch {
      out[n] = { fileId };
    }
  }
  return out;
}
