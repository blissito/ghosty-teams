// Del submit al room: UN solo mensaje por formulario, que crece.
//
// El entregable es una hoja (artefacto `kind:"sheet"`) con una fila por respuesta: con 100
// respuestas nadie abre 100 archivos, y lo que se revisa, se filtra y se le pasa a alguien
// más es una tabla. Se descarga en Excel por el camino nativo que ya existía.
//
// Y hay UN mensaje, no uno por respuesta. Hubo card-por-respuesta y estaba mal por dos
// razones que se vieron en cuanto llegaron cinco: el hilo se convierte en una lista de
// tarjetas que nadie abre, y la tarjeta de la hoja —lo único que de verdad se quiere abrir—
// queda enterrada entre ellas. Ahora ese mensaje se REESCRIBE en cada respuesta (cuántas
// van, quién fue la última) y lleva la hoja colgada, así que lo último siempre está a un
// clic. El aviso por correo/push sigue siendo por respuesta: enterarse es otra cosa que
// revisar.
import type { FormField } from "../../lib/form-fields";
import type { FormRow } from "./publish.server";

export type DeliverArgs = {
  form: FormRow;
  submissionId: number;
  data: Record<string, string>;
  files: Record<string, { fileId: string; name?: string; mime?: string; size?: number }>;
};

export async function deliverSubmission(a: DeliverArgs): Promise<{ messageId: number } | null> {
  const { dbq } = await import("../../dbq.server");
  const { form, data } = a;
  const quien = identidad(form.fields, data);

  // El contador va ANTES de pintar el mensaje: su texto lo dice ("van N"), y leerlo de la
  // fila vieja mostraría uno menos justo en la respuesta que lo provoca.
  await dbq(
    `UPDATE gt_forms SET submission_count = submission_count + 1, last_submitted_at = unixepoch() WHERE id = ?`,
    [form.id]
  );

  const messageId = await actualizarHoja({ ...form, submissionCount: form.submissionCount + 1 }, quien).catch(
    (e) => {
      console.error("[form deliver] hoja falló", e);
      return null;
    }
  );
  if (messageId) {
    await dbq(`UPDATE gt_form_submissions SET message_id = ? WHERE id = ?`, [messageId, a.submissionId]);
  }

  // La gracia de un intake es enterarse sin tener la pestaña abierta. Esto SÍ es por
  // respuesta: el mensaje del room se reescribe, pero el aviso es de una que acaba de llegar.
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

  return messageId ? { messageId } : null;
}

/** El texto del mensaje único: cuántas van y quién fue la última. */
function cuerpoHoja(form: FormRow, quien: string): string {
  const n = form.submissionCount;
  return (
    `📊 **Respuestas — ${form.title}** · ${n} ${n === 1 ? "respuesta" : "respuestas"}` +
    (quien ? ` · última: **${quien}**` : "") +
    `\nÁbrela para verlas todas o descárgala en Excel.`
  );
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
async function actualizarHoja(form: FormRow, quien: string): Promise<number> {
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

  const csv = hojaCsv(form, rows.map((r) => ({
    at: num(r.created_at),
    data: safeJson<Record<string, string>>(r.data_json, {}),
    files: safeJson<Record<string, { name?: string }>>(r.files_json, {}),
  })));

  // Primera respuesta: nace su burbuja. NO puede colgar del mensaje del formulario:
  // `attachArtifacts` se queda con UN artefacto por mensaje, así que la hoja taparía al
  // formulario en su propia tarjeta. De la segunda en adelante se REESCRIBE ese mismo
  // mensaje: es lo que evita el hilo lleno de tarjetas.
  let messageId = form.sheetMessageId;
  let documentId = form.sheetDocumentId;
  const esNuevo = !messageId || !documentId;
  const cuerpo = cuerpoHoja(form, quien);
  if (esNuevo) {
    const { id } = await db.postAgent(
      form.channelId,
      form.anchorMessageId,
      cuerpo,
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
  // El compilador no puede saber que la rama de arriba las dejó puestas.
  if (messageId == null || documentId == null) throw new Error("hoja sin ancla");
  if (!esNuevo) {
    // `setMessageBody` y no `editMessage`: esto no es una edición de su autor, así que no
    // debe salir marcado como "(editado)".
    await db.setMessageBody(messageId, cuerpo);
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
      // La PRIMERA vez, `message:new` (el mensaje no existe en el cliente todavía).
      // Después NO sirve: su handler descarta por id lo que ya conoce —para no duplicar—
      // y se quedaba con el artefacto VIEJO, o sea la hoja sin las filas nuevas. Por eso
      // de la segunda en adelante va un `refresh`, que hace refetch del contexto y trae
      // el mensaje con su última versión. (`message:body` sólo repinta el TEXTO; el
      // artefacto no viaja en ese evento.)
      if (esNuevo) {
        bus.publish(bus.ch.room(form.ns, form.channelId), { t: "message:new", msg: withMeta });
      } else {
        bus.publish(bus.ch.room(form.ns, form.channelId), { t: "message:body", id: messageId, body: cuerpo });
        bus.publish(bus.ch.room(form.ns, form.channelId), {
          t: "refresh",
          channelId: form.channelId,
          parentId: form.anchorMessageId,
        });
      }
    }
  } catch (e) {
    console.error("[form deliver] fanout de la hoja falló", e);
  }
  return messageId;
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


