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

// Ventana de 60s. Dos cubetas: con IP y sin IP. El original se SALTABA el límite cuando no
// podía leer la IP, o sea que bastaba un proxy mal configurado para no tener límite.
const WINDOW_S = 60;
const MAX_WITH_IP = 10;
const MAX_NO_IP = 5;

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

        let payload: { _idem?: string; _hp?: string; data?: Record<string, unknown> };
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
          if (form.status === "closed") {
            return json({ ok: false, errors: { _form: "Este formulario ya no recibe respuestas." } }, 200);
          }

          const ip = clientIp(request);
          const { ipHash, allowed } = await rateCheck(form.id, ip);
          if (!allowed) {
            return json({ ok: false, errors: { _form: "Demasiados envíos. Espera un momento." } }, 429);
          }

          const { validateSubmission } = await import("../lib/form-fields");
          const v = validateSubmission(form.fields, payload.data ?? {});
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

function clientIp(request: Request): string | null {
  const xff = request.headers.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  return first || request.headers.get("cf-connecting-ip") || null;
}

/**
 * Rate limit en la DB del tenant: un contador in-process no sobrevive un deploy ni sirve con
 * más de un proceso. Cuesta un round-trip por submit, aceptable para un intake.
 */
async function rateCheck(formId: string, ip: string | null): Promise<{ ipHash: string | null; allowed: boolean }> {
  const crypto = await import("node:crypto");
  const salt = process.env.GHOSTY_PARTNER_SECRET ?? "";
  // Hasheada, nunca en claro: sirve para el límite y para investigar abuso, no para
  // identificar a quien contesta.
  const ipHash = ip ? crypto.createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32) : null;
  const bucket = ipHash ?? "unknown";
  const max = ipHash ? MAX_WITH_IP : MAX_NO_IP;
  const windowStart = Math.floor(Date.now() / 1000 / WINDOW_S) * WINDOW_S;

  try {
    const { dbq, num } = await import("../dbq.server");
    const rows = await dbq(
      `INSERT INTO gt_form_rate (form_id, bucket, window_start, count) VALUES (?,?,?,1)
       ON CONFLICT(form_id, bucket, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
      [formId, bucket, windowStart]
    );
    // Limpieza oportunista de ventanas viejas: sin cron, sin tabla que crezca sola.
    if (num(rows[0]?.count) === 1) {
      await dbq(`DELETE FROM gt_form_rate WHERE window_start < ?`, [windowStart - WINDOW_S * 10]).catch(() => []);
    }
    return { ipHash, allowed: num(rows[0]?.count) <= max };
  } catch (e) {
    // Un fallo del contador no debe tirar el formulario: se deja pasar y se loguea.
    console.error("[form submit] rate check falló", e);
    return { ipHash, allowed: true };
  }
}

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
