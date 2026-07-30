// Del submit al room: una card con el resumen + LA HOJA de respuestas.
//
// El entregable es UNA hoja por formulario que crece (artefacto `kind:"sheet"`), no un
// documento por respuesta: con 100 respuestas nadie abre 100 archivos, y lo que se revisa,
// se filtra y se le pasa a alguien más es una tabla. Se descarga en Excel por el camino
// nativo que ya existía.
//
// Las cards cuelgan como HILO del mensaje del formulario, para que un intake con volumen no
// inunde el topic.
import type { FormField } from "../../lib/form-fields";
import type { FormRow } from "./publish.server";

export type DeliverArgs = {
  form: FormRow;
  submissionId: number;
  data: Record<string, string>;
  files: Record<string, { fileId: string; name?: string; mime?: string; size?: number }>;
};

export async function deliverSubmission(a: DeliverArgs): Promise<{ messageId: number } | null> {
  const db = await import("../../db.server");
  const { dbq } = await import("../../dbq.server");
  const bus = await import("../bus.server");

  const { form, data } = a;
  const quien = identidad(form.fields, data);

  const card =
    `📋 **Nueva respuesta — ${form.title}**` +
    (quien ? ` · **${quien}**` : "") +
    `\n${resumen(form.fields, data)}\nÁbrela en la hoja de respuestas.`;

  const { id: messageId } = await db.postAgent(
    form.channelId,
    // En el hilo del formulario: agrupa las respuestas bajo su origen y deja el topic limpio.
    form.anchorMessageId,
    card,
    "msg",
    form.agentHandle || "ghosty",
    form.agentName || "Ghosty",
    form.topic,
    form.agentAvatar || ""
  );

  await dbq(`UPDATE gt_form_submissions SET message_id = ? WHERE id = ?`, [messageId, a.submissionId]);

  // El entregable es UNA hoja que crece, no un documento por respuesta: a las 100 nadie
  // abre 100 archivos, y lo que se revisa, se filtra y se le pasa a alguien más es una
  // tabla. (Hubo un documento por respuesta y se quitó a propósito: duplicaba el trabajo
  // y ensuciaba el hilo. Si alguna respuesta merece su propio escrito, el agente lo redacta
  // a partir de la hoja, que para eso la puede leer.)
  await actualizarHoja(form).catch((e) => console.error("[form deliver] hoja falló", e));
  await dbq(
    `UPDATE gt_forms SET submission_count = submission_count + 1, last_submitted_at = unixepoch() WHERE id = ?`,
    [form.id]
  );

  try {
    const msg = await db.getMessage(messageId);
    if (msg) {
      const [withMeta] = await db.attachArtifacts([msg]);
      bus.publish(bus.ch.room(form.ns, form.channelId), { t: "message:new", msg: withMeta });
    }
  } catch (e) {
    console.error("[form deliver] fanout falló", e);
  }

  // La gracia de un intake es enterarse sin tener la pestaña abierta.
  if (form.ownerSub) {
    try {
      const rows = await dbq("SELECT slug FROM gc_channels WHERE id = ?", [form.channelId]);
      const { notify } = await import("../notify.server");
      await notify(
        {
          kind: "form",
          recipients: [form.ownerSub],
          title: `📋 Nueva respuesta — ${form.title}`,
          body: quien ? `De ${quien}` : "Ya está en la hoja de respuestas.",
          url: rows[0]?.slug ? `/c/${rows[0].slug}` : "/",
        },
        form.ns
      );
    } catch (e) {
      console.error("[form deliver] notify falló", e);
    }
  }

  return { messageId };
}

/**
 * La hoja de respuestas del formulario: una fila por respuesta, una columna por campo.
 *
 * Se RECONSTRUYE entera desde `gt_form_submissions` en cada envío, no se le añade una fila
 * al final. Tres cosas salen gratis de eso: dos respuestas simultáneas no se pisan (no hay
 * leer-modificar-escribir sobre el artefacto), un cambio de campos se refleja en toda la
 * tabla, y como CADA versión trae todas las filas, la poda de versiones viejas no pierde
 * nada — la verdad es la tabla y la hoja es una proyección.
 */
async function actualizarHoja(form: FormRow): Promise<void> {
  const { randomUUID } = await import("node:crypto");
  const db = await import("../../db.server");
  const { dbq, num } = await import("../../dbq.server");
  const bus = await import("../bus.server");
  const { publishArtifactVersion } = await import("../artifacts");
  const { safeJson } = await import("./submissions.server");

  const rows = await dbq(
    `SELECT created_at, data_json, files_json FROM gt_form_submissions WHERE form_id = ? ORDER BY id ASC`,
    [form.id]
  );
  if (!rows.length) return;

  const csv = hojaCsv(form, rows.map((r) => ({
    at: num(r.created_at),
    data: safeJson<Record<string, string>>(r.data_json, {}),
    files: safeJson<Record<string, { name?: string }>>(r.files_json, {}),
  })));

  // Primera respuesta: nace su propia burbuja. NO puede colgar del mensaje del formulario:
  // `attachArtifacts` se queda con UN artefacto por mensaje, así que la hoja taparía al
  // formulario en su propia tarjeta.
  let messageId = form.sheetMessageId;
  let documentId = form.sheetDocumentId;
  if (!messageId || !documentId) {
    const { id } = await db.postAgent(
      form.channelId,
      form.anchorMessageId,
      `📊 **Respuestas — ${form.title}** · se actualiza con cada respuesta nueva. Ábrela para verlas todas o descárgala en Excel.`,
      "msg",
      form.agentHandle || "ghosty",
      form.agentName || "Ghosty",
      form.topic,
      form.agentAvatar || ""
    );
    messageId = id;
    documentId = `sheet_${randomUUID()}`;
    await dbq(`UPDATE gt_forms SET sheet_message_id = ?, sheet_document_id = ? WHERE id = ?`, [
      messageId,
      documentId,
      form.id,
    ]);
  }

  await publishArtifactVersion({
    messageId,
    documentId,
    kind: "sheet",
    title: `Respuestas — ${form.title}`,
    md: csv,
    ownerSub: form.ownerSub,
  });

  try {
    const msg = await db.getMessage(messageId);
    if (msg) {
      const [withMeta] = await db.attachArtifacts([msg]);
      bus.publish(bus.ch.room(form.ns, form.channelId), { t: "message:new", msg: withMeta });
    }
  } catch (e) {
    console.error("[form deliver] fanout de la hoja falló", e);
  }
}

/** CSV con encabezados legibles (las etiquetas del formulario, no las claves internas). */
export function hojaCsv(
  form: Pick<FormRow, "fields">,
  filas: { at: number; data: Record<string, string>; files: Record<string, { name?: string }> }[]
): string {
  const cols = form.fields;
  const cab = ["Fecha", ...cols.map((f) => f.label)];
  const lineas = [cab.map(csvCell).join(",")];
  for (const fila of filas) {
    const celdas = [
      new Date(fila.at * 1000).toLocaleString("es-MX", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }),
      ...cols.map((f) => valorPlano(f, fila.data, fila.files)),
    ];
    lineas.push(celdas.map(csvCell).join(","));
  }
  return lineas.join("\n");
}

/** Un valor por celda: la matriz se aplana a "fila: respuesta; fila: respuesta". */
function valorPlano(
  f: FormField,
  data: Record<string, string>,
  files: Record<string, { name?: string }>
): string {
  // Ausente = el flujo no lo preguntó (showIf). Vacío, no "—": una celda con guión en una
  // hoja se filtra y se cuenta como dato.
  if (!(f.name in data)) return "";
  const v = data[f.name] ?? "";
  if (f.type === "checkbox") return v === "true" ? "Sí" : "";
  if (f.type === "file") return files[f.name]?.name ?? (v ? "archivo" : "");
  if (f.type === "matrix") {
    let sel: Record<string, string> = {};
    try {
      sel = v ? (JSON.parse(v) as Record<string, string>) : {};
    } catch {
      return v;
    }
    return (f.rows ?? []).filter((r) => sel[r]).map((r) => `${r}: ${sel[r]}`).join("; ");
  }
  return v;
}

/** Comillas sólo cuando hacen falta, y las internas duplicadas (RFC-4180). */
function csvCell(s: string): string {
  const t = String(s ?? "");
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

/** Quién respondió, para el título de la ficha y la card. */
function identidad(fields: FormField[], data: Record<string, string>): string {
  for (const k of ["razon_social", "empresa", "nombre", "contacto", "nombre_completo"]) {
    if (data[k]) return data[k].slice(0, 70);
  }
  const primero = fields.find((f) => f.type === "text" && data[f.name]);
  return primero ? data[primero.name].slice(0, 70) : "";
}

/** Dos o tres campos para la burbuja; el resto vive en la hoja. */
function resumen(fields: FormField[], data: Record<string, string>): string {
  const cortos = fields.filter(
    (f) => data[f.name] && f.type !== "matrix" && f.type !== "textarea" && f.type !== "file"
  );
  return cortos
    .slice(0, 3)
    // El texto lo escribió un tercero y va dentro de un mensaje que se renderiza como
    // markdown: los caracteres de formato se neutralizan.
    .map((f) => `• ${f.label}: ${escapeMd(data[f.name]).slice(0, 60)}`)
    .join("\n");
}

/** El texto lo escribió un tercero: los caracteres de markdown se neutralizan. */
function escapeMd(s: string): string {
  return String(s)
    .replace(/([*_`[\]|#>])/g, "\\$1")
    .replace(/\r?\n/g, " ");
}
