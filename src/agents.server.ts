// Resolución y routing de agentes (multi-agente). El "ghosty" implícito del
// wizard (config) + los gc_agents extra (fleet o webhook). Módulo puro server
// (sin createServerFn) para que lo usen tanto chat.ts como server/agents.ts sin
// ciclos de import.

export type ResolvedAgent = {
  handle: string;
  name: string;
  avatar: string;
  systemPrompt: string | null; // persona por-agente (se envía/antepone al backend)
  backend:
    | { kind: "fleet"; id: string; token: string }
    | { kind: "webhook"; url: string };
};

// Agentes habilitados de la instancia: primero el del wizard, luego gc_agents.
export async function resolvedAgents(): Promise<ResolvedAgent[]> {
  const db = await import("./db.server");
  const { getGhostyFleet, getConfig } = await import("./config.server");
  const out: ResolvedAgent[] = [];
  const fleet = await getGhostyFleet();
  if (fleet) {
    const name = (await getConfig("fleet_name")) || "Ghosty";
    out.push({
      handle: db.GHOSTY_HANDLE,
      name,
      avatar: "/ghosty.svg",
      systemPrompt: (await getConfig("ghosty_prompt")) || null,
      backend: { kind: "fleet", id: fleet.id, token: fleet.token },
    });
  }
  for (const a of await db.listAgents()) {
    if (!a.enabled) continue;
    if (a.kind === "webhook" && a.webhook_url) {
      out.push({ handle: a.handle, name: a.name, avatar: a.avatar || "", systemPrompt: a.system_prompt, backend: { kind: "webhook", url: a.webhook_url } });
    } else if (a.fleet_id && a.fleet_token) {
      out.push({ handle: a.handle, name: a.name, avatar: a.avatar || "", systemPrompt: a.system_prompt, backend: { kind: "fleet", id: a.fleet_id, token: a.fleet_token } });
    }
  }
  return out;
}

// ── Media (A2A FilePart) — entrega de adjuntos al agente ────────────────────
// Contrato: docs/AGENT-MEDIA-CONTRACT.md §2/§3. Un FilePart por adjunto, tipado por
// MIME → cubre audio/imagen/video/docs/desconocido con una sola forma. Transporte
// híbrido: `bytes` inline si es chico (self-contained), `uri` firmada si es grande.
export type MediaPart = {
  kind: "file";
  file: { name?: string; mimeType: string; uri?: string; bytes?: string };
};

const MEDIA_INLINE_MAX_BYTES = 256 * 1024; // < 256KB → bytes inline; ≥ → uri firmada

export async function buildMediaParts(
  attachments: { fileId: string; mime: string | null; size: number | null; name: string | null }[]
): Promise<MediaPart[]> {
  if (!attachments.length) return [];
  const { mintReadUrl, mintFileBytes } = await import("./server/easybits-files.server");
  const parts: MediaPart[] = [];
  for (const a of attachments) {
    const mimeType = a.mime || "application/octet-stream";
    const name = a.name || undefined;
    const small = a.size != null && a.size < MEDIA_INLINE_MAX_BYTES;
    if (small) {
      const bytes = await mintFileBytes(a.fileId);
      if (bytes) {
        parts.push({ kind: "file", file: { name, mimeType, bytes } });
        continue;
      }
    }
    // Grande, o falló el inline → uri firmada (TTL corto lo controla EasyBits).
    const uri = await mintReadUrl(a.fileId);
    if (uri) parts.push({ kind: "file", file: { name, mimeType, uri } });
  }
  return parts;
}

// ¿Qué agente se mencionó en el body? Devuelve el handle o null (el primero que
// aparezca, entre los habilitados). Case-insensitive, @handle con borde de palabra.
export function detectMention(body: string, handles: string[]): string | null {
  return detectMentions(body, handles)[0] ?? null;
}

// TODOS los agentes mencionados, en orden de aparición (para multi-mención: cada
// uno responde). Case-insensitive, @handle con borde de palabra, sin duplicados.
export function detectMentions(body: string, handles: string[]): string[] {
  const hits: { handle: string; idx: number }[] = [];
  for (const h of handles) {
    const re = new RegExp(`@${h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    const m = body.match(re);
    if (m && m.index != null) hits.push({ handle: h, idx: m.index });
  }
  return hits.sort((a, b) => a.idx - b.idx).map((x) => x.handle);
}

// Artefacto vivo con identidad + versiones (Fase 1): instrucción per-turno SOLO para el
// canal Teams/web (panel de artefacto + editor colab). El agente usa la tool `artifact`
// (edit-in-place): un documento NUEVO = artifact_create; MODIFICAR el mismo = artifact_update
// con su id → nueva versión (no una tarjeta nueva). GTeams detecta la url del doc y la abre
// como editor colab editable. Docs con membrete/tablas/slides/PDF con diseño → skills normales.
const EB_DOC_STREAM_GUARDRAIL = [
  "REGLA ABSOLUTA (canal Teams/web) — TIENE PRIORIDAD sobre docs-router, DOC_ROUTING y cualquier skill:",
  "para CUALQUIER documento de PROSA (nda, carta, oficio, contrato, convenio, demanda, dictamen, memo, minuta, acuerdo) PROHIBIDO invocar docs-router, el skill oficio, structured_doc, upload_file o mcp__wa__. NO subas archivos ni generes .docx tú.",
  "En su lugar escribe el documento COMPLETO como Markdown DENTRO de un bloque que abre con ```eb-doc y cierra con ```. Ese bloque se muestra redactándose EN VIVO en el panel y la plataforma lo guarda como documento editable con VERSIONES.",
  "Fuera del bloque, solo UNA frase breve de contexto, SIN links. Usa # para el título, ## para cláusulas, listas y **negritas** dentro del bloque.",
  "MODIFICAR el documento de esta conversación (cambia/ajusta/corrige/cuadra/reescribe/agrega): vuelve a escribir el documento COMPLETO y actualizado OTRA VEZ dentro del ```eb-doc``` — la plataforma actualiza el MISMO documento (nueva versión), no crea uno nuevo. NUNCA escribas solo el fragmento.",
  "ÚNICA EXCEPCIÓN: documentos con membrete de marca fijo, tablas/hojas de cálculo (xlsx) o presentaciones (pptx) → skills normales. Todo lo demás de prosa → SIEMPRE el bloque eb-doc.",
].join(" ");

// Si el hilo YA tiene un documento, se lo recordamos al agente → al modificar reescribe
// el documento COMPLETO en el fence y el servidor actualiza ESE documento (nueva versión).
function artifactGuardrail(currentDocId?: string | null): string {
  if (!currentDocId) return EB_DOC_STREAM_GUARDRAIL;
  return (
    EB_DOC_STREAM_GUARDRAIL +
    " NOTA: en esta conversación YA existe un documento vivo. Si el usuario pide modificarlo, reescribe el documento COMPLETO y actualizado dentro del ```eb-doc``` — la plataforma lo reconoce y actualiza ese mismo documento (nueva versión), no crea uno nuevo."
  );
}

// Streaming (first-class): llama al backend y emite la respuesta pedacito a
// pedacito por `onChunk`, devolviendo el texto final (autoritativo). Hoy solo el
// backend fleet expone SSE (EasyBits /message-stream: `chunk`/`done`/`error`); el
// webhook aún cae al camino bloqueante (Slice 4 = cliente A2A message/stream).
// Contrato: docs/AGENT-MEDIA-CONTRACT.md §1.
export async function callAgentBackendStream(
  agent: ResolvedAgent,
  groupId: string,
  sender: string,
  text: string,
  onChunk: (chunk: string) => void | Promise<void>,
  parts: MediaPart[] = [],
  onTool?: (name: string) => void | Promise<void>,
  currentDocId?: string | null
): Promise<string> {
  if (agent.backend.kind !== "fleet") {
    // Sin SSE todavía: colecta el reply completo y lo emite de un tirón (el cliente
    // ya lo ve aterrizar). Cuando exista un webhook A2A real, aquí va message/stream.
    const full = await callAgentBackend(agent, groupId, sender, text, parts);
    if (full) await onChunk(full);
    return full;
  }
  const persona = agent.systemPrompt?.trim() || null;
  const base = process.env.EASYBITS_BASE_URL ?? "https://www.easybits.cloud";
  const outText = persona ? `[Instrucciones para ${agent.name}: ${persona}]\n\n${text}` : text;
  try {
    const res = await fetch(`${base}/api/v2/fleet-agents/${agent.backend.id}/message-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${agent.backend.token}` },
      // `parts` = FileParts A2A (media); EasyBits los normaliza por MIME (Slice E1).
      // configGroupId "teams" = unidad de config ESTABLE de este canal en EasyBits
      // (tools + comportamiento por-Teams via groupConfigs["teams"]); sin él la config
      // caería por-conversación (groupId) → solo el default del agente.
      body: JSON.stringify({
        groupId,
        configGroupId: "teams",
        sender: sender || "invitado",
        text: outText,
        parts,
        appendSystemPrompt: artifactGuardrail(currentDocId),
      }),
    });
    if (!res.ok || !res.body) throw new Error(`fleet-stream ${res.status}: ${await res.text().catch(() => "")}`);
    // Parseo SSE: acumula por líneas `data: {json}`. `done.value` es el reply
    // completo y autoritativo (correcto aun si un self-heal re-emitió chunks).
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let streamed = "";
    let authoritative: string | null = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let ev: { type?: string; value?: string; message?: string; name?: string };
        try {
          ev = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        if (ev.type === "chunk" && ev.value) {
          streamed += ev.value;
          await onChunk(ev.value);
        } else if (ev.type === "tool" && ev.name) {
          await onTool?.(ev.name);
        } else if (ev.type === "done") {
          authoritative = ev.value ?? streamed;
        } else if (ev.type === "error") {
          throw new Error(ev.message || "fleet stream error");
        }
      }
    }
    return authoritative || streamed || "(sin respuesta)";
  } catch (e) {
    const msg = `⚠️ No pude contactar a @${agent.handle}: ${e instanceof Error ? e.message : e}`;
    await onChunk(msg);
    return msg;
  }
}

// Orquestador común (room + DM) del turno de un agente con streaming first-class.
// La CÁSCARA del reply se crea PEREZOSAMENTE al primer token (via createShell) → el
// "pensando…" se mantiene durante la latencia del agente y recién ahí se reemplaza.
// El caller provee cómo crear la cáscara y cómo emitir deltas (room=ch.room,
// DM=per-miembro ch.user). Devuelve {id, reply}; el caller persiste el body final.
// Contrato: docs/AGENT-MEDIA-CONTRACT.md §1.2.
// Labels SEMÁNTICOS (whitelist): un tool crudo → {ing: gerundio en-progreso, done:
// pasado}. Solo acciones SIGNIFICATIVAS para el usuario aparecen en el checklist —
// lo demás (lecturas get_/list_, ToolSearch, TodoWrite, plumbing) devuelve null y NO
// se muestra (ruido). Estilo Claude: "Creó el documento", no "Set page html".
const TOOL_LABELS: Record<string, { ing: string; done: string }> = {
  create_document: { ing: "Creando el documento", done: "Creó el documento" },
  structured_doc: { ing: "Generando el documento", done: "Generó el documento" },
  set_section_html: { ing: "Editando el documento", done: "Editó el documento" },
  set_page_html: { ing: "Editando el documento", done: "Editó el documento" },
  update_document: { ing: "Editando el documento", done: "Editó el documento" },
  insert_page: { ing: "Agregando una página", done: "Agregó una página" },
  reorder_pages: { ing: "Reordenando páginas", done: "Reordenó las páginas" },
  clone_document: { ing: "Clonando el documento", done: "Clonó el documento" },
  apply_brand_kit: { ing: "Aplicando la marca", done: "Aplicó la marca" },
  change_document_format: { ing: "Cambiando el formato", done: "Cambió el formato" },
  create_or_edit_image: { ing: "Editando una imagen", done: "Editó una imagen" },
  edit_image: { ing: "Editando una imagen", done: "Editó una imagen" },
  upload_file: { ing: "Subiendo el documento", done: "Subió el documento" },
  create_share_link: { ing: "Generando el link", done: "Generó un link para compartir" },
  render_url: { ing: "Renderizando a PDF", done: "Renderizó a PDF" },
  render_html: { ing: "Renderizando a PDF", done: "Renderizó a PDF" },
  office_to_pdf: { ing: "Convirtiendo a PDF", done: "Convirtió a PDF" },
  deploy_document: { ing: "Publicando el documento", done: "Publicó el documento" },
  create_website: { ing: "Creando el sitio", done: "Creó el sitio" },
  WebSearch: { ing: "Buscando en la web", done: "Buscó en la web" },
  // El agente redacta docs invocando un Skill (oficio/xlsx/pptx/doc-remix) → la acción
  // visible = "Redactó el documento" (antes solo se veía "Subió", el paso final).
  Skill: { ing: "Redactando el documento", done: "Redactó el documento" },
  artifact_create: { ing: "Redactando el documento", done: "Redactó el documento" },
  artifact_update: { ing: "Actualizando el documento", done: "Actualizó el documento" },
};

function toolLabel(raw: string): { ing: string; done: string } | null {
  const short = raw.replace(/^mcp__[^_]+__/, "").replace(/^mcp__/, "");
  // Solo whitelist: si no tiene label semántico, es ruido → no se muestra.
  return TOOL_LABELS[raw] || TOOL_LABELS[short] || null;
}

export async function runAgentTurn(opts: {
  agent: ResolvedAgent | undefined;
  handle: string;
  groupId: string;
  sender: string;
  text: string;
  parts?: MediaPart[];
  createShell: () => Promise<number>; // limpia status, postea cáscara, publica message:new, devuelve id
  emitDelta: (id: number, chunk: string) => void;
  // Reemplaza el body completo (no append). Para el checklist incremental: al iniciar
  // una tool, las previas pasan a ✓ y la nueva queda ⚡ → se re-pinta la lista entera.
  emitBody?: (id: number, body: string) => void;
  // documentId del artefacto ACTUAL del hilo → se inyecta al guardrail para edit-in-place.
  currentDocId?: string | null;
}): Promise<{ id: number; reply: string }> {
  let id: number | null = null;
  const ensure = async (): Promise<number> => {
    if (id == null) id = await opts.createShell();
    return id;
  };
  // Estado del turno. El BODY visible = checklist + texto acumulado, SIEMPRE re-pintado
  // entero por emitBody (nunca se clobbea el texto ni se pierde en el flicker). `acc`
  // acumula el texto del agente con separadores entre segmentos interrumpidos por tools
  // (si no, "…contrato." + "Contrato generado" se pegan → muro amontonado).
  const tools: { ing: string; done: string }[] = [];
  let acc = "";
  let brokeByTool = false; // corrió una tool desde el último texto → el próximo es segmento nuevo
  let anyActivity = false;  // corrió CUALQUIER tool (aunque oculta) → hay trabajo en curso
  let ebDocSeen = false;    // el reply abrió un bloque ```eb-doc``` (redacción en vivo, sin tools)

  // El checklist ES el indicador de "trabajando" (reemplaza el "pensando…"). Si hay
  // actividad pero aún ninguna tool semántica, muestra "⏳ Trabajando…" para que el
  // usuario vea feedback YA, no un "pensando" colgado.
  const renderChecklist = (allDone: boolean): string => {
    if (tools.length) {
      return (
        tools
          .map((tl, i) => `- ${allDone || i < tools.length - 1 ? `✅ ${tl.done}` : `⏳ ${tl.ing}`}`)
          .join("\n") + "\n\n"
      );
    }
    return anyActivity && !allDone ? "- ⏳ Trabajando…\n\n" : "";
  };
  const renderBody = (allDone: boolean): string => renderChecklist(allDone) + acc;
  const paint = async (allDone = false) => {
    const bodyId = await ensure();
    if (opts.emitBody) opts.emitBody(bodyId, renderBody(allDone));
  };

  const onChunk = async (chunk: string) => {
    if (!chunk) return;
    if (opts.emitBody) {
      // Separa un segmento de texto nuevo (tras una tool) con doble salto → párrafos, no muro.
      if (brokeByTool && acc.trim() && chunk.trim()) acc += "\n\n";
      if (chunk.trim()) brokeByTool = false;
      acc += chunk;
      // eb-doc no llama tools → sin esto el checklist quedaría vacío. Sintetiza una
      // entrada "Redactó el documento" en cuanto aparece el bloque.
      if (!ebDocSeen && acc.includes("```eb-doc")) {
        ebDocSeen = true;
        anyActivity = true;
        if (!tools.some((t) => t.done === "Redactó el documento")) {
          tools.push({ ing: "Redactando el documento", done: "Redactó el documento" });
        }
      }
      await paint();
    } else {
      opts.emitDelta(await ensure(), chunk); // fallback legacy (append)
    }
  };
  const onTool = async (name: string) => {
    anyActivity = true;
    // CUALQUIER tool (aunque sea oculta: Bash/Read/Write) corta el segmento de texto →
    // el próximo texto va en párrafo nuevo. (Bug: antes solo se marcaba con tools CON
    // label → "…docx." + [Bash] + "El NDA…" quedaba pegado "docx.El".)
    brokeByTool = true;
    const label = toolLabel(name);
    // Dedup por acción (varios Skill/tools con el mismo label → una sola línea).
    if (label && !tools.some((t) => t.done === label.done)) {
      tools.push(label);
    }
    // Aun si la tool es oculta, re-pinta → la cáscara nace YA y "pensando" desaparece.
    if (opts.emitBody) await paint();
    else if (label) opts.emitDelta(await ensure(), `- ⏳ ${label.ing}\n`);
  };

  let reply: string;
  if (!opts.agent) {
    reply = `👾 @${opts.handle} no está conectado. El owner lo configura en Ajustes → Agentes.`;
    await onChunk(reply);
  } else {
    reply = await callAgentBackendStream(opts.agent, opts.groupId, opts.sender, opts.text, onChunk, opts.parts ?? [], onTool, opts.currentDocId);
  }
  // `acc` (con separadores) es el texto bonito; reply es la acumulación cruda del stream.
  const finalText = acc.trim() || reply || "(sin respuesta)";
  // Body final autoritativo: checklist TODO ✅ + texto separado. El caller lo persiste.
  return { id: await ensure(), reply: renderChecklist(true) + finalText };
}

// Llama al backend del agente y devuelve su respuesta en texto.
export async function callAgentBackend(
  agent: ResolvedAgent,
  groupId: string,
  sender: string,
  text: string,
  parts: MediaPart[] = []
): Promise<string> {
  const persona = agent.systemPrompt?.trim() || null;
  if (agent.backend.kind === "webhook") {
    try {
      // Webhook: contrato que SÍ controlamos → mandamos identidad + persona explícita
      // (el bot rutea su prompt por agente), el texto crudo, y los FileParts (media).
      const res = await fetch(agent.backend.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          groupId,
          sender,
          text,
          parts,
          agent: { handle: agent.handle, name: agent.name },
          systemPrompt: persona,
        }),
      });
      if (!res.ok) throw new Error(`webhook ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { reply?: string };
      return data.reply ?? "(sin respuesta)";
    } catch (e) {
      return `⚠️ No pude contactar a @${agent.handle}: ${e instanceof Error ? e.message : e}`;
    }
  }
  // fleet: el endpoint de EasyBits solo acepta {groupId, sender, text}, así que la
  // persona se ANTEPONE al texto como preámbulo (única palanca desde nuestro lado).
  const base = process.env.EASYBITS_BASE_URL ?? "https://www.easybits.cloud";
  const outText = persona ? `[Instrucciones para ${agent.name}: ${persona}]\n\n${text}` : text;
  try {
    const res = await fetch(`${base}/api/v2/fleet-agents/${agent.backend.id}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${agent.backend.token}` },
      // configGroupId "teams" = unidad de config estable del canal (ver message-stream).
      body: JSON.stringify({
        groupId,
        configGroupId: "teams",
        sender: sender || "invitado",
        text: outText,
        parts,
        appendSystemPrompt: EB_DOC_STREAM_GUARDRAIL,
      }),
    });
    if (!res.ok) throw new Error(`fleet ${res.status}: ${await res.text()}`);
    return ((await res.json()) as { reply?: string }).reply ?? "(sin respuesta)";
  } catch (e) {
    return `⚠️ No pude contactar a @${agent.handle}: ${e instanceof Error ? e.message : e}`;
  }
}
