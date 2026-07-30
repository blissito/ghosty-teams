// Crear, publicar y releer formularios nativos.
//
// El formulario público ES un artefacto: se publica por `publishArtifactVersion` con
// `kind:"artifact"` y se comparte con `visibility:"link"`, así que la liga que se reparte
// es `/artefacto/<slug>` — la misma superficie que ya sirve permisos, versión congelada e
// iframe aislado. No hay ruta de hosting nueva ni HTML en una tabla propia.
//
// Republicar (editar campos, cerrar el formulario) inserta una VERSIÓN del mismo
// `document_id`: mismo slug, misma URL. Las ligas ya repartidas siguen sirviendo.
import { randomUUID } from "node:crypto";
import { validateSchema, type FormField } from "../../lib/form-fields";
import { mintFormToken } from "./token.server";

export type FormRow = {
  id: string;
  ns: string;
  channelId: number;
  topic: string;
  anchorMessageId: number | null;
  title: string;
  fields: FormField[];
  intro: string | null;
  thanks: string | null;
  ownerSub: string | null;
  agentHandle: string | null;
  agentName: string | null;
  agentAvatar: string | null;
  documentId: string | null;
  shareSlug: string | null;
  origin: string | null;
  status: "open" | "closed";
  submissionCount: number;
  lastSubmittedAt: number | null;
};

const COLS = `id, ns, channel_id, topic, anchor_message_id, title, schema_json, intro, thanks,
  owner_sub, agent_handle, agent_name, agent_avatar, document_id, share_slug, origin,
  status, submission_count, last_submitted_at`;

function toRow(r: Record<string, string | null>): FormRow {
  const n = (v: string | null) => Number(v ?? 0);
  let fields: FormField[] = [];
  try {
    fields = JSON.parse(r.schema_json ?? "[]") as FormField[];
  } catch {
    /* schema corrupto: mejor un formulario vacío que un 500 en /forms */
  }
  return {
    id: r.id!,
    ns: r.ns!,
    channelId: n(r.channel_id),
    topic: r.topic || "general",
    anchorMessageId: r.anchor_message_id != null ? n(r.anchor_message_id) : null,
    title: r.title ?? "Formulario",
    fields,
    intro: r.intro ?? null,
    thanks: r.thanks ?? null,
    ownerSub: r.owner_sub ?? null,
    agentHandle: r.agent_handle ?? null,
    agentName: r.agent_name ?? null,
    agentAvatar: r.agent_avatar ?? null,
    documentId: r.document_id ?? null,
    shareSlug: r.share_slug ?? null,
    origin: r.origin ?? null,
    status: r.status === "closed" ? "closed" : "open",
    submissionCount: n(r.submission_count),
    lastSubmittedAt: r.last_submitted_at != null ? n(r.last_submitted_at) : null,
  };
}

export async function getForm(id: string): Promise<FormRow | null> {
  const { dbq } = await import("../../dbq.server");
  const rows = await dbq(`SELECT ${COLS} FROM gt_forms WHERE id = ?`, [id]);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function listForms(): Promise<FormRow[]> {
  const { dbq } = await import("../../dbq.server");
  const rows = await dbq(
    `SELECT ${COLS} FROM gt_forms ORDER BY COALESCE(last_submitted_at, created_at) DESC`
  );
  return rows.map(toRow);
}

/** La liga pública que se reparte. `null` hasta que el formulario se publica. */
export function formUrl(f: FormRow): string | null {
  if (!f.shareSlug) return null;
  const base = (f.origin || "").replace(/\/$/, "");
  return base ? `${base}/artefacto/${f.shareSlug}` : `/artefacto/${f.shareSlug}`;
}

export type CreateFormArgs = {
  channelId: number;
  topic?: string;
  title: string;
  fields: unknown;
  intro?: string | null;
  thanks?: string | null;
  ownerSub: string;
  agentHandle?: string | null;
  agentName?: string | null;
  agentAvatar?: string | null;
};

export async function createForm(
  a: CreateFormArgs
): Promise<{ ok: true; form: FormRow; url: string | null } | { ok: false; error: string }> {
  const v = validateSchema(a.fields);
  if (!v.ok) return { ok: false, error: v.error };
  const title = String(a.title ?? "").trim();
  if (!title) return { ok: false, error: "falta el título del formulario" };

  const { dbq } = await import("../../dbq.server");
  const { currentNamespace } = await import("../tenant.server");
  const { reqOrigin } = await import("../../origin.server");
  const ns = await currentNamespace();
  // El origin se CONGELA en la fila: las URLs de submit y upload van horneadas dentro del
  // HTML publicado, y una republicación desde un timer (sin request) no tendría host que
  // mirar. Es el host del tenant, estable toda la vida del workspace.
  const origin = await reqOrigin().catch(() => "");

  const id = `form_${randomUUID()}`;
  await dbq(
    `INSERT INTO gt_forms (id, ns, channel_id, topic, title, schema_json, intro, thanks,
       owner_sub, agent_handle, agent_name, agent_avatar, origin)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      ns,
      a.channelId,
      a.topic || "general",
      title,
      JSON.stringify(v.fields),
      a.intro?.trim() || null,
      a.thanks?.trim() || null,
      a.ownerSub,
      a.agentHandle || null,
      a.agentName || null,
      a.agentAvatar || null,
      origin || null,
    ]
  );

  const form = await getForm(id);
  if (!form) return { ok: false, error: "no se pudo guardar el formulario" };
  return publishForm(form);
}

export type UpdateFormArgs = {
  title?: string;
  fields?: unknown;
  intro?: string | null;
  thanks?: string | null;
  status?: "open" | "closed";
};

export async function updateForm(
  id: string,
  patch: UpdateFormArgs
): Promise<{ ok: true; form: FormRow; url: string | null } | { ok: false; error: string }> {
  const cur = await getForm(id);
  if (!cur) return { ok: false, error: "ese formulario no existe" };

  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.title !== undefined) {
    const t = String(patch.title).trim();
    if (!t) return { ok: false, error: "el título no puede quedar vacío" };
    sets.push("title = ?");
    args.push(t);
  }
  if (patch.fields !== undefined) {
    const v = validateSchema(patch.fields);
    if (!v.ok) return { ok: false, error: v.error };
    sets.push("schema_json = ?");
    args.push(JSON.stringify(v.fields));
  }
  if (patch.intro !== undefined) {
    sets.push("intro = ?");
    args.push(patch.intro?.trim() || null);
  }
  if (patch.thanks !== undefined) {
    sets.push("thanks = ?");
    args.push(patch.thanks?.trim() || null);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    args.push(patch.status === "closed" ? "closed" : "open");
  }
  if (!sets.length) return { ok: false, error: "no mandaste ningún cambio" };

  const { dbq } = await import("../../dbq.server");
  sets.push("updated_at = unixepoch()");
  args.push(id);
  await dbq(`UPDATE gt_forms SET ${sets.join(", ")} WHERE id = ?`, args);

  const next = await getForm(id);
  if (!next) return { ok: false, error: "ese formulario ya no existe" };
  return publishForm(next);
}

/**
 * Publica (o republica) el HTML del formulario como versión del artefacto.
 *
 * La primera vez postea el mensaje ANCLA en el room: `gc_artifacts.message_id` necesita un
 * mensaje, y de paso es la burbuja donde la gente ve la liga y —colgadas como hilo— las
 * respuestas que vayan llegando.
 */
export async function publishForm(
  form: FormRow
): Promise<{ ok: true; form: FormRow; url: string | null } | { ok: false; error: string }> {
  const db = await import("../../db.server");
  const { dbq } = await import("../../dbq.server");
  const bus = await import("../bus.server");
  const { publishArtifactVersion } = await import("../artifacts");
  const { renderFormHtml } = await import("./render.server");

  const token = mintFormToken({ id: form.id, ns: form.ns });
  const base = (form.origin || "").replace(/\/$/, "");
  const html = renderFormHtml({
    title: form.title,
    fields: form.fields,
    intro: form.intro,
    thanks: form.thanks,
    submitUrl: `${base}/api/form/${token}`,
    uploadUrl: `${base}/api/form-upload/${token}`,
  });

  const documentId = form.documentId ?? `form_doc_${randomUUID()}`;
  let anchorId = form.anchorMessageId;

  if (!anchorId) {
    const { id } = await db.postAgent(
      form.channelId,
      null,
      `📋 **${form.title}** — formulario de intake. Comparte la liga; las respuestas llegan a este hilo.`,
      "msg",
      form.agentHandle || "ghosty",
      form.agentName || "Ghosty",
      form.topic,
      form.agentAvatar || ""
    );
    anchorId = id;
  }

  await publishArtifactVersion({
    messageId: anchorId,
    documentId,
    kind: "artifact",
    title: form.title,
    md: html,
    // Público: la copia en storage tiene que servirse sin firma, y un formulario no
    // tiene nada que ocultar (las RESPUESTAS sí, y ésas viven en otro artefacto).
    visibility: "public",
    ownerSub: form.ownerSub,
    // Sin sembrar ids ni hornear Tailwind: este HTML no lo escribió el agente, trae su
    // propio CSS y su JS no debe pasar por un transformador de DOM.
    stamp: false,
    // Sin `setPointer`: apuntar el hilo al formulario haría que el siguiente
    // "modifícalo" del usuario cayera sobre él en vez de sobre lo que estaba trabajando.
    notify: () => bus.publish(bus.ch.room(form.ns, form.channelId), { t: "refresh", channelId: form.channelId, parentId: null }),
  });

  // El share vive en la fila RAÍZ del documento (cada versión es una fila nueva). El slug
  // NO se rota al republicar: rotarlo mataría en silencio las ligas ya repartidas.
  const root = await db.shareRootFor(documentId);
  let slug = root?.slug ?? null;
  if (root && (!root.slug || root.visibility !== "link")) {
    slug = root.slug ?? randomUUID();
    await db.setShareOnRoot(root.id, { slug, visibility: "link" });
  }

  await dbq(
    `UPDATE gt_forms SET document_id = ?, share_slug = ?, anchor_message_id = ?, updated_at = unixepoch() WHERE id = ?`,
    [documentId, slug, anchorId, form.id]
  );

  // La burbuja ancla ya con su artefacto colgado, en el room, sin recargar.
  const esNuevo = !form.documentId;
  try {
    const msg = await db.getMessage(anchorId);
    if (msg) {
      const [withMeta] = await db.attachArtifacts([msg]);
      bus.publish(bus.ch.room(form.ns, form.channelId), { t: "message:new", msg: withMeta });
    }
    // Y se abre en el panel para QUIEN lo pidió. Sólo al crearlo: al editarlo, abrirlo de
    // golpe le quitaría de la pantalla lo que esté mirando. Al canal personal, nunca al
    // room — el panel de los demás es su pantalla, no la nuestra.
    if (esNuevo && form.ownerSub) {
      bus.publish(bus.ch.user(form.ns, form.ownerSub), { t: "artifact:open", messageId: anchorId });
    }
  } catch (e) {
    console.error("[form publish] fanout falló", e);
  }

  const next = (await getForm(form.id)) ?? form;
  return { ok: true, form: next, url: formUrl(next) };
}
