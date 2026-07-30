import { createFileRoute } from "@tanstack/react-router";

// POST /api/form-upload/<token> → sube el archivo de un campo `type:"file"`.
//
// `api/upload` no sirve para esto: exige sesión (el iframe del formulario tiene origen
// opaco, no manda cookies) o una firma `ts.upload`, cuyo secreto no puede vivir dentro del
// HTML de una página pública. Así que el formulario tiene su propia puerta, autorizada por
// lo mismo que el submit: el token dice a qué formulario pertenece.
//
// El objeto va al bucket PRIVADO y la respuesta guarda sólo su key. Quien responde no
// recibe ninguna URL de lectura: los adjuntos de un intake son del expediente, no del
// visitante.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Cache-Control": "no-store",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Más bajo que los 25MB de un adjunto de chat a propósito: esto lo sube un desconocido.
const MAX_BYTES = 10 * 1024 * 1024;

export const Route = createFileRoute("/api/form-upload/$token")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),

      POST: async ({ params, request }: { params: { token: string }; request: Request }) => {
        const { verifyFormToken } = await import("../server/forms/token.server");
        const ref = verifyFormToken(params.token);
        if (!ref) return json({ ok: false, error: "no encontrado" }, 404);

        let form: FormData;
        try {
          form = await request.formData();
        } catch {
          return json({ ok: false, error: "cuerpo inválido" }, 400);
        }
        const file = form.get("file");
        const field = String(form.get("field") ?? "");
        if (!(file instanceof File)) return json({ ok: false, error: "falta el archivo" }, 400);
        if (file.size === 0) return json({ ok: false, error: "el archivo está vacío" }, 400);
        if (file.size > MAX_BYTES) return json({ ok: false, error: "el archivo pasa de 10 MB" }, 413);

        const { withNamespace } = await import("../server/tenant.server");
        return withNamespace(ref.ns, async () => {
          const { ensureSchema } = await import("../server/schema.server");
          await ensureSchema();
          const { getForm } = await import("../server/forms/publish.server");
          const f = await getForm(ref.id);
          if (!f || f.ns !== ref.ns) return json({ ok: false, error: "no encontrado" }, 404);
          if (f.status === "closed") return json({ ok: false, error: "el formulario está cerrado" }, 200);

          // El campo tiene que existir Y ser de tipo archivo: sin esto, el endpoint sería
          // un bucket abierto colgado de cualquier formulario público.
          const def = f.fields.find((x) => x.name === field);
          if (!def || def.type !== "file") return json({ ok: false, error: "ese campo no acepta archivos" }, 400);

          const storage = await import("../server/storage.server");
          if (!storage.storageConfigured()) return json({ ok: false, error: "storage no configurado" }, 503);

          const safeName = (file.name || "archivo").replace(/[^\w.\- ]+/g, "_").slice(0, 80);
          try {
            const put = await storage.put({
              blob: file,
              contentType: file.type || "application/octet-stream",
              fileName: safeName,
              visibility: "private",
            });
            const { dbq } = await import("../dbq.server");
            await dbq(
              `INSERT INTO gt_form_files (file_id, form_id, field, name, mime, size) VALUES (?,?,?,?,?,?)`,
              [put.key, f.id, field, safeName, file.type || null, file.size]
            );
            // Se devuelve el nombre saneado, no una URL: el fileId es lo único que el
            // formulario reenvía en el submit.
            return json({ ok: true, fileId: put.key, name: safeName, size: file.size });
          } catch (e) {
            console.error("[form upload] falló", e);
            return json({ ok: false, error: "no se pudo subir el archivo" }, 502);
          }
        });
      },
    },
  },
});
