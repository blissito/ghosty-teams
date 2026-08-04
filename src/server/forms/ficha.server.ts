// La ficha de UNA respuesta: el documento con lo que contestó una sola persona.
//
// Existió automática y se quitó a propósito (`9b06121`, "la hoja es el entregable"): con
// cinco respuestas el hilo era una lista de tarjetas que nadie abría, y la de la hoja
// —lo único que de verdad se quiere abrir— quedaba enterrada entre ellas. Vuelve con tres
// cambios que corrigen justo eso:
//
//   1. **Bajo demanda.** `ficha_mode` nace en 'off'. Ningún formulario ya publicado cambia
//      de comportamiento, y el camino normal sigue siendo pedirla cuando hace falta.
//   2. **Colgada del hilo de la HOJA**, no al lado de ella. El tablero de arriba no se
//      mueve; las fichas se acumulan dentro.
//   3. **Fanout `refresh` y nunca `message:new`.** Eso era lo que llenaba la pantalla.
//
// Y es INMUTABLE: retrata lo que se preguntó ese día. Si mañana cambian los campos, la hoja
// —que es una proyección y se reconstruye entera— cambia con ellos; la ficha no. Ésa es la
// diferencia conceptual entre las dos, y la razón de que valga la pena tener ambas.
import type { FormField } from "../../lib/form-fields";
import { fill, formStrings, type FormStrings } from "../../lib/form-strings";
import { identidad } from "./deliver.server";
import type { FormRow } from "./publish.server";

export type EnsureFichaResult =
  | { ok: true; documentId: string; messageId: number | null; created: boolean }
  | { ok: false; error: string };

/**
 * Publica la ficha de una respuesta, UNA sola vez.
 *
 * El submit ya es idempotente por `idem_key`, pero eso no alcanza aquí: a la ficha se llega
 * también por la tool y por el botón de `/forms`, así que tiene que ser idempotente por su
 * cuenta. La reserva es un compare-and-swap sobre `ficha_document_id` (`WHERE … IS NULL` y
 * después releer para ver quién ganó) porque el cliente de sqld no devuelve filas afectadas.
 * Si el posteo falla, la reserva se suelta: no queremos una respuesta marcada como "ya tiene
 * ficha" sin ficha.
 */
export async function ensureFicha(a: { formId: string; submissionId: number }): Promise<EnsureFichaResult> {
  const { randomUUID } = await import("node:crypto");
  const { dbq, num } = await import("../../dbq.server");
  const { getForm } = await import("./publish.server");
  const { safeJson } = await import("./submissions.server");

  const form = await getForm(a.formId);
  if (!form) return { ok: false, error: "ese formulario no existe" };

  const rows = await dbq(
    `SELECT id, created_at, data_json, files_json, ficha_document_id, ficha_message_id
       FROM gt_form_submissions WHERE id = ? AND form_id = ?`,
    [a.submissionId, a.formId]
  );
  const sub = rows[0];
  // El `form_id` va en el WHERE a propósito: sin él, un id de respuesta de OTRO formulario
  // del mismo workspace publicaría su ficha en este hilo.
  if (!sub) return { ok: false, error: "esa respuesta no existe en ese formulario" };

  if (sub.ficha_document_id) {
    return {
      ok: true,
      documentId: sub.ficha_document_id,
      messageId: sub.ficha_message_id != null ? num(sub.ficha_message_id) : null,
      created: false,
    };
  }

  const documentId = `ficha_${randomUUID()}`;
  await dbq(
    `UPDATE gt_form_submissions SET ficha_document_id = ? WHERE id = ? AND ficha_document_id IS NULL`,
    [documentId, a.submissionId]
  );
  const check = await dbq(
    `SELECT ficha_document_id, ficha_message_id FROM gt_form_submissions WHERE id = ?`,
    [a.submissionId]
  );
  if (check[0]?.ficha_document_id !== documentId) {
    // Otro camino se nos adelantó entre el SELECT y el UPDATE. La suya vale igual.
    return {
      ok: true,
      documentId: check[0]?.ficha_document_id ?? documentId,
      messageId: check[0]?.ficha_message_id != null ? num(check[0].ficha_message_id) : null,
      created: false,
    };
  }

  try {
    const data = safeJson<Record<string, string>>(sub.data_json, {});
    const files = safeJson<Record<string, { name?: string }>>(sub.files_json, {});
    const messageId = await publicar(form, {
      submissionId: a.submissionId,
      at: num(sub.created_at),
      data,
      files,
      documentId,
    });
    await dbq(`UPDATE gt_form_submissions SET ficha_message_id = ? WHERE id = ?`, [messageId, a.submissionId]);
    return { ok: true, documentId, messageId, created: true };
  } catch (e) {
    await dbq(
      `UPDATE gt_form_submissions SET ficha_document_id = NULL WHERE id = ? AND ficha_document_id = ?`,
      [a.submissionId, documentId]
    );
    console.error("[form ficha] falló", e);
    return { ok: false, error: "no se pudo publicar la ficha" };
  }
}

async function publicar(
  form: FormRow,
  r: {
    submissionId: number;
    at: number;
    data: Record<string, string>;
    files: Record<string, { name?: string }>;
    documentId: string;
  }
): Promise<number> {
  const db = await import("../../db.server");
  const bus = await import("../bus.server");
  const { publishArtifactVersion } = await import("../artifacts");

  const s = formStrings(form.locale);
  const quien = identidad(form.fields, r.data);
  const cuerpo = quien ? fill(s.fichaMessage, { who: quien }) : s.fichaMessageAnon;

  // Cuelga del mensaje de la HOJA cuando existe. Ése es el cambio de fondo respecto de
  // julio: antes caía al lado de la hoja y la enterraba. Si todavía no hay hoja (ficha
  // pedida antes de la primera entrega), cae del ancla del formulario.
  const parentId = form.sheetMessageId ?? form.anchorMessageId;
  const { id: messageId } = await db.postAgent(
    form.channelId,
    parentId,
    cuerpo,
    "msg",
    form.agentHandle || "ghosty",
    form.agentName || "Ghosty",
    form.topic,
    form.agentAvatar || ""
  );

  await publishArtifactVersion({
    messageId,
    documentId: r.documentId,
    kind: "doc",
    title: `${s.fichaLabel} — ${quien || form.title}`,
    md: fichaMarkdown(form, r.data, r.files, r.at),
    // El dueño es quien creó el formulario, no quien respondió (que no tiene cuenta): es el
    // único que puede compartirla y cambiarle los permisos.
    ownerSub: form.ownerSub,
    // Sin `setPointer`: la ficha no debe secuestrar el artefacto vivo del hilo — el
    // siguiente "modifícalo" del usuario caería sobre ella.
  });

  // `refresh` y NUNCA `message:new`: con `auto` prendido, un evento por respuesta es
  // exactamente lo que hizo insufrible la versión de julio.
  try {
    bus.publish(bus.ch.room(form.ns, form.channelId), {
      t: "refresh",
      channelId: form.channelId,
      parentId,
    });
  } catch (e) {
    console.error("[form ficha] fanout falló", e);
  }

  return messageId;
}

/**
 * El markdown de la ficha. Recuperado de `3242eca` (lo borró el commit que quitó la ficha),
 * más las listas repetibles, que no existían entonces.
 *
 * Regla que se conserva: un campo AUSENTE de los datos es un campo que el flujo no mostró
 * (`showIf`), y no se imprime como vacío — nunca se preguntó. Uno presente y vacío sí sale
 * con guión, porque se preguntó y no contestaron: son dos cosas distintas y en un expediente
 * la diferencia importa.
 */
export function fichaMarkdown(
  form: Pick<FormRow, "title" | "fields" | "locale">,
  data: Record<string, string>,
  files: Record<string, { name?: string }>,
  at?: number
): string {
  const s = formStrings(form.locale);
  const out: string[] = [`# ${form.title}`, "", fill(s.fichaAnsweredOn, { date: fecha(at, form.locale) }), ""];
  let seccion: string | null = null;

  for (const f of form.fields) {
    if (!(f.name in data)) continue;

    if (f.section && f.section !== seccion) {
      seccion = f.section;
      out.push(`## ${f.section}`, "");
    }

    const v = data[f.name] ?? "";

    if (f.type === "group") {
      out.push(`### ${f.label}`, "", ...grupoLista(f, v), "");
      continue;
    }
    if (f.type === "matrix") {
      out.push(`### ${f.label}`, "", ...matrixTable(f, v, s), "");
      continue;
    }
    if (f.type === "file") {
      const meta = files[f.name];
      out.push(`**${f.label}:** ${meta?.name ? `📎 ${escapeMd(meta.name)}` : "—"}`, "");
      continue;
    }
    if (f.type === "checkbox") {
      out.push(`**${f.label}:** ${v === "true" ? s.yes : "—"}`, "");
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

/**
 * Una lista repetible sale como lista numerada, no como tabla.
 *
 * Con seis subcampos una tabla se sale de la página en el editor y en el PDF, y aquí no hay
 * nada que filtrar —para eso está la hoja—: la ficha se LEE.
 */
function grupoLista(f: FormField, value: string): string[] {
  let items: Record<string, string>[] = [];
  try {
    const parsed = JSON.parse(value || "[]");
    if (Array.isArray(parsed)) items = parsed as Record<string, string>[];
  } catch {
    /* dato corrupto: la sección sale vacía, no se tumba la ficha entera */
  }
  if (!items.length) return ["—"];
  const subs = f.fields ?? [];
  const out: string[] = [];
  items.forEach((it, i) => {
    out.push(`${i + 1}. **${escapeMd(String(it[subs[0]?.name ?? ""] ?? `${i + 1}`))}**`);
    for (const sub of subs.slice(1)) {
      if (!(sub.name in (it ?? {}))) continue;
      out.push(`   - ${escapeMd(sub.label)}: ${it[sub.name] ? escapeMd(it[sub.name]) : "—"}`);
    }
  });
  return out;
}

function matrixTable(f: FormField, value: string, s: FormStrings): string[] {
  let sel: Record<string, string> = {};
  try {
    sel = value ? (JSON.parse(value) as Record<string, string>) : {};
  } catch {
    /* respuesta corrupta: la tabla sale con guiones */
  }
  const lines = [`| | ${s.fichaAnswerColumn} |`, "| --- | --- |"];
  for (const r of f.rows ?? []) lines.push(`| ${escapeMd(r)} | ${sel[r] ? escapeMd(sel[r]) : "—"} |`);
  return lines;
}

function fecha(at: number | undefined, locale: FormRow["locale"]): string {
  const d = at ? new Date(at * 1000) : new Date();
  return d.toLocaleString(locale === "en" ? "en-US" : "es-MX", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Un pipe o un asterisco de quien responde no debe romper la tabla ni poner en negritas. */
function escapeMd(s: string): string {
  return String(s)
    .replace(/([*_`[\]|#>])/g, "\\$1")
    .replace(/\r?\n/g, " ");
}
