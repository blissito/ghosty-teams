// Lectura de respuestas: para la tool `form_submissions` y para /forms.
import type { FormField } from "../../lib/form-fields";

export type SubmissionRow = {
  id: number;
  createdAt: number;
  data: Record<string, string>;
  files: Record<string, { fileId: string; name?: string; mime?: string; size?: number }>;
  messageId: number | null;
  fichaDocumentId: string | null;
};

export async function listSubmissions(a: { formId: string; limit?: number; since?: string }): Promise<
  | { ok: true; formId: string; title: string; total: number; submissions: Array<Record<string, unknown>> }
  | { ok: false; error: string }
> {
  const { getForm } = await import("./publish.server");
  const form = await getForm(a.formId);
  if (!form) return { ok: false, error: "ese formulario no existe" };

  const limit = Math.min(100, Math.max(1, Math.floor(a.limit ?? 20)));
  const args: unknown[] = [a.formId];
  let where = "form_id = ?";
  if (a.since && /^\d{4}-\d{2}-\d{2}$/.test(a.since)) {
    where += " AND created_at >= ?";
    args.push(Math.floor(new Date(`${a.since}T00:00:00Z`).getTime() / 1000));
  }
  args.push(limit);

  const { dbq, num } = await import("../../dbq.server");
  const rows = await dbq(
    `SELECT id, created_at, data_json, files_json, message_id, ficha_document_id
       FROM gt_form_submissions WHERE ${where} ORDER BY id DESC LIMIT ?`,
    args
  );

  // Etiquetas en vez de claves internas: el agente lee esto y lo repite al usuario, y
  // "razon_social" en una respuesta se lee como una fuga del esquema interno.
  const labels = new Map(form.fields.map((f) => [f.name, f.label]));
  const grupos = new Map(form.fields.filter((f) => f.type === "group").map((f) => [f.name, f]));

  return {
    ok: true,
    formId: form.id,
    title: form.title,
    total: form.submissionCount,
    submissions: rows.map((r) => {
      const data = safeJson<Record<string, string>>(r.data_json, {});
      const out: Record<string, unknown> = {
        id: num(r.id),
        at: new Date(num(r.created_at) * 1000).toISOString(),
        fichaDocumentId: r.ficha_document_id ?? null,
        respuestas: Object.fromEntries(
          Object.entries(data).map(([k, v]) => [labels.get(k) ?? k, valorLegible(k, v, grupos)])
        ),
      };
      const files = safeJson<Record<string, unknown>>(r.files_json, {});
      if (Object.keys(files).length) out.archivos = files;
      return out;
    }),
  };
}

/**
 * Una lista repetible se guarda como JSON dentro de un string (para no cambiar el tipo de
 * `data_json`), pero al agente se le entrega ya RE-HIDRATADA y con etiquetas: si le llega el
 * string crudo lo repite tal cual al usuario, o peor, se pone a parsearlo él.
 *
 * Es re-hidratación en LECTURA: no toca ninguna fila guardada y se puede quitar.
 */
function valorLegible(
  key: string,
  raw: string,
  grupos: Map<string, import("../../lib/form-fields").FormField>
): unknown {
  const g = grupos.get(key);
  if (!g) return raw;
  const items = safeJson<Record<string, string>[]>(raw, []);
  if (!Array.isArray(items)) return raw;
  const subs = new Map((g.fields ?? []).map((f) => [f.name, f.label]));
  return items.map((it) =>
    Object.fromEntries(Object.entries(it ?? {}).map(([k, v]) => [subs.get(k) ?? k, v]))
  );
}

export function safeJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Los campos con archivo, para pintar la ficha y para autorizar la descarga. */
export function fileFields(fields: FormField[]): string[] {
  return fields.filter((f) => f.type === "file").map((f) => f.name);
}
