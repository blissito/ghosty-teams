// Del submit al room: card + FICHA como artefacto-documento NATIVO.
//
// La ficha se arma en MARKDOWN y `publishArtifactVersion({kind:"doc"})` lo convierte a
// bloques `v:1` con `docEnvelopeFromMd`. Markdown y no HTML porque `mdToBlocks` es el único
// traductor bendecido del repo, y de paso las dos restricciones duras del editor se cumplen
// gratis: no hay forma de anidar una tabla ni de ponerle un ancho en porcentaje.
//
// Cada respuesta es un DOCUMENTO NUEVO (no una versión del anterior): son registros
// distintos, no borradores del mismo. Y cuelga como HILO del mensaje del formulario, para
// que un intake con volumen no inunde el topic.
import type { FormField } from "../../lib/form-fields";
import type { FormRow } from "./publish.server";

export type DeliverArgs = {
  form: FormRow;
  submissionId: number;
  data: Record<string, string>;
  files: Record<string, { fileId: string; name?: string; mime?: string; size?: number }>;
};

export async function deliverSubmission(a: DeliverArgs): Promise<{ messageId: number; documentId: string } | null> {
  const { randomUUID } = await import("node:crypto");
  const db = await import("../../db.server");
  const { dbq } = await import("../../dbq.server");
  const bus = await import("../bus.server");
  const { publishArtifactVersion } = await import("../artifacts");

  const { form, data, files } = a;
  const quien = identidad(form.fields, data);

  const card =
    `📋 **Nueva respuesta — ${form.title}**` +
    (quien ? ` · **${quien}**` : "") +
    `\n${resumen(form.fields, data)}\nAbre la ficha para verla completa.`;

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

  const documentId = `doc_${randomUUID()}`;
  await publishArtifactVersion({
    messageId,
    documentId,
    kind: "doc",
    title: `Respuesta — ${form.title}${quien ? ` · ${quien}` : ""}`,
    md: fichaMarkdown(form, data, files),
    // El dueño es quien creó el formulario, no quien respondió (que no tiene cuenta):
    // es el único que puede compartir la ficha y cambiarle los permisos.
    ownerSub: form.ownerSub,
    // Sin `setPointer`: la ficha no debe secuestrar el artefacto vivo del hilo.
  });

  await dbq(`UPDATE gt_form_submissions SET message_id = ?, ficha_document_id = ? WHERE id = ?`, [
    messageId,
    documentId,
    a.submissionId,
  ]);
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
          body: quien ? `De ${quien}` : "Ya está la ficha en el expediente.",
          url: rows[0]?.slug ? `/c/${rows[0].slug}` : "/",
        },
        form.ns
      );
    } catch (e) {
      console.error("[form deliver] notify falló", e);
    }
  }

  return { messageId, documentId };
}

/** Quién respondió, para el título de la ficha y la card. */
function identidad(fields: FormField[], data: Record<string, string>): string {
  for (const k of ["razon_social", "empresa", "nombre", "contacto", "nombre_completo"]) {
    if (data[k]) return data[k].slice(0, 70);
  }
  const primero = fields.find((f) => f.type === "text" && data[f.name]);
  return primero ? data[primero.name].slice(0, 70) : "";
}

/** Dos o tres campos para la burbuja; el resto vive en la ficha. */
function resumen(fields: FormField[], data: Record<string, string>): string {
  const cortos = fields.filter(
    (f) => data[f.name] && f.type !== "matrix" && f.type !== "textarea" && f.type !== "file"
  );
  return cortos
    .slice(0, 3)
    .map((f) => `• ${f.label}: ${escapeMd(data[f.name]).slice(0, 60)}`)
    .join("\n");
}

/**
 * La ficha en markdown. Una tabla POR matriz, nunca anidada, y sin anchos: es lo que el
 * editor de bloques puede representar y lo que el export a Word puede reproducir.
 */
export function fichaMarkdown(
  form: FormRow,
  data: Record<string, string>,
  files: Record<string, { fileId: string; name?: string }>
): string {
  const out: string[] = [`# ${form.title}`, "", `_Respondido el ${fecha()}_`, ""];
  let seccion: string | null = null;

  for (const f of form.fields) {
    // Un campo que no está en los datos es un campo que el flujo NO mostró: no se
    // imprime como "vacío", porque nunca se preguntó.
    if (!(f.name in data)) continue;

    if (f.section && f.section !== seccion) {
      seccion = f.section;
      out.push(`## ${f.section}`, "");
    }

    const v = data[f.name] ?? "";

    if (f.type === "matrix") {
      out.push(`### ${f.label}`, "", ...matrixTable(f, v), "");
      continue;
    }
    if (f.type === "file") {
      const meta = files[f.name];
      out.push(`**${f.label}:** ${meta?.name ? `📎 ${escapeMd(meta.name)}` : "—"}`, "");
      continue;
    }
    if (f.type === "checkbox") {
      out.push(`**${f.label}:** ${v === "true" ? "Sí" : "—"}`, "");
      continue;
    }
    if (f.type === "textarea") {
      out.push(`**${f.label}:**`, "", v ? escapeMd(v) : "—", "");
      continue;
    }
    out.push(`**${f.label}:** ${v ? escapeMd(v) : "—"}`, "");
  }

  return out.join("\n");
}

function matrixTable(f: FormField, value: string): string[] {
  let sel: Record<string, string> = {};
  try {
    sel = value ? (JSON.parse(value) as Record<string, string>) : {};
  } catch {
    /* respuesta corrupta: la tabla sale con guiones */
  }
  const rows = f.rows ?? [];
  const lines = ["| | Respuesta |", "| --- | --- |"];
  for (const r of rows) lines.push(`| ${escapeMd(r)} | ${sel[r] ? escapeMd(sel[r]) : "—"} |`);
  return lines;
}

function fecha(): string {
  return new Date().toLocaleString("es-MX", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** El texto lo escribió un tercero: los caracteres de markdown se neutralizan. */
function escapeMd(s: string): string {
  return String(s).replace(/([*_`[\]|#>])/g, "\\$1").replace(/\r?\n/g, " ");
}
