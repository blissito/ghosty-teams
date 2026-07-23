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
  const rows = await db.listAgents();
  // @ghosty implícito (gc_config) SOLO si aún no se migró a fila gc_agents (dedup por
  // handle) — evita duplicarlo una vez que listManagedAgentsFn lo materializó.
  const fleet = await getGhostyFleet();
  // Dedup por fleet_id (no por handle) → robusto si el owner renombró el @handle del
  // @ghosty ya migrado. Sin fila con ese fleet_id → aún no migrado, lo añadimos.
  // (OJO: NO deduplicar por handle — el implícito del config trae el token FRESCO del
  // reconnect; una fila gc_agents @ghosty puede tener un fleet_token viejo → 401. El
  // implícito debe poder responder. La doble entrada @ghosty se resuelve reconciliando
  // el backend, no ocultando el que funciona. Incidente 2026-07-14.)
  if (fleet && !rows.some((a) => a.fleet_id === fleet.id)) {
    const name = (await getConfig("fleet_name")) || "Ghosty";
    out.push({
      handle: db.GHOSTY_HANDLE,
      name,
      avatar: "/ghosty.svg",
      systemPrompt: (await getConfig("ghosty_prompt")) || null,
      backend: { kind: "fleet", id: fleet.id, token: fleet.token },
    });
  }
  for (const a of rows) {
    if (!a.enabled) continue;
    if (a.kind === "webhook" && a.webhook_url) {
      out.push({ handle: a.handle, name: a.name, avatar: a.avatar || "", systemPrompt: a.system_prompt, backend: { kind: "webhook", url: a.webhook_url } });
    } else if (a.fleet_id && a.fleet_token) {
      out.push({ handle: a.handle, name: a.name, avatar: a.avatar || "", systemPrompt: a.system_prompt, backend: { kind: "fleet", id: a.fleet_id, token: a.fleet_token } });
    }
  }
  return out;
}

// Refresca el fleet_token (pool) de un agente cuando caducó: renueva el OAuth con el
// refresh_token y re-lista la flota para tomar el token FRESCO del agente; lo persiste
// en config si es el @ghosty del wizard. Best-effort → null si el refresh no funciona
// (falta client creds / refresh_token expirado → hace falta un connect completo).
export async function refreshFleetToken(fleetId: string): Promise<string | null> {
  try {
    const { refreshOwnerToken } = await import("./server/easybits-files.server");
    const fresh = await refreshOwnerToken();
    if (!fresh) return null;
    const { listFleetAgents } = await import("./server/easybits-oauth.server");
    const agents = (await listFleetAgents(fresh)) as Array<{ id: string; token?: string }>;
    const a = agents.find((x) => x.id === fleetId);
    if (!a?.token) return null;
    const { getConfig, setConfig } = await import("./config.server");
    if ((await getConfig("fleet_agent_id")) === fleetId) await setConfig("fleet_token", a.token);
    return a.token;
  } catch {
    return null;
  }
}

// Warm seam: pre-calienta el turno de un agente ANTES de que el usuario envíe (se dispara
// al elegir @handle en el composer). Hoy: resuelve el agente (calienta el grafo de imports
// + la lectura de gc_agents) y abre la conexión al backend de la flota (DNS/TLS/keep-alive)
// para que el primer POST /message-stream no pague ese costo. Best-effort, nunca lanza.
// LÍMITE: el verdadero cuello (cold-start de la SESIÓN del worker) NO se puede calentar
// desde aquí — no hay endpoint ligero en la flota (solo turnos completos).
// TODO: cuando EasyBits exponga /warm|session-open, pingearlo aquí para primar la sesión.
export async function warmAgent(handle: string): Promise<void> {
  try {
    const agent = (await resolvedAgents()).find((a) => a.handle === handle);
    if (!agent || agent.backend.kind !== "fleet") return;
    const base = process.env.EASYBITS_BASE_URL ?? "https://www.easybits.cloud";
    await fetch(base, { method: "HEAD" }).catch(() => {}); // calienta la conexión
  } catch {
    // best-effort: el warm nunca debe afectar el flujo del usuario
  }
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

// ── Quote-reply (cita) ──────────────────────────────────────────────────────
// Extracto plano del mensaje citado para el SNAPSHOT (denormalizado en el mensaje).
// Quita bloques eb-doc/eb-sheet (ruido enorme) y colapsa espacios; ~220 chars.
export function quoteExcerpt(body: string): string {
  const stripped = (body || "")
    .replace(/```eb-(doc|sheet|artifact)[\s\S]*?```/g, "[documento]")
    .replace(/```[\s\S]*?```/g, "[código]")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > 220 ? stripped.slice(0, 220) + "…" : stripped;
}

// Superficie para el agente: embebe la cita EN el texto del turno (patrón WABA/Baileys
// contextInfo.quotedMessage) → el agente SIEMPRE ve a qué se está respondiendo, sin
// tener que buscar en el historial. Va en el TEXTO (no en el system prompt) porque
// cambia por turno.
export function quotedContextPrefix(author: string, excerpt: string, body: string): string {
  const who = author?.trim() || "alguien";
  const cite = (excerpt || "").trim();
  if (!cite) return body;
  return `[En respuesta a un mensaje de ${who}]\n> ${cite}\n\n[Mensaje]\n${body}`;
}

// Cita COMPLETA para el agente: a diferencia del excerpt del snapshot (220 chars + tapa
// bloques), conserva el contenido real del mensaje citado (para que "dame tips sobre ESTO"
// tenga el material). Cap generoso para no explotar el turno.
export function clampQuote(body: string, max = 2000): string {
  const s = (body || "").trim();
  return s.length > max ? s.slice(0, max) + "\n…[citado recortado]" : s;
}

// Bloque de HISTORIAL reciente para el turno del agente: resuelve referencias ("otra vez",
// "esto", "lo de antes") aunque la memoria del worker esté fría o un turno haya fallado.
// Va en el TEXTO (cambia por turno). Omite el mensaje ACTUAL (ya va aparte) y los vacíos.
export function historyContext(
  messages: { sender: string; agent_handle: string | null; body: string }[],
  currentBody: string
): string {
  const cur = (currentBody || "").trim();
  const lines: string[] = [];
  let total = 0;
  for (const m of messages) {
    const body = (m.body || "").trim();
    if (!body || body === cur) continue; // vacío o el propio turno actual
    const who = m.agent_handle ? `@${m.agent_handle}` : m.sender || "usuario";
    const snippet = body.length > 1200 ? body.slice(0, 1200) + "…" : body;
    const line = `${who}: ${snippet}`;
    if (total + line.length > 6000) break;
    total += line.length;
    lines.push(line);
  }
  if (!lines.length) return "";
  return `[Historial reciente de la conversación (de más antiguo a más nuevo), SOLO como contexto — no lo repitas literal]\n${lines.join("\n")}\n\n`;
}

// ¿Qué agente se mencionó en el body? Devuelve el handle o null (el primero que
// aparezca, entre los habilitados). Case-insensitive, @handle con borde de palabra.
export function detectMention(body: string, handles: string[]): string | null {
  return detectMentions(body, handles)[0] ?? null;
}

// TODOS los agentes mencionados, en orden de aparición (para multi-mención: cada
// uno responde). Case-insensitive, @handle con borde de palabra a ambos lados, sin
// duplicados. El boundary IZQUIERDO `(?<![\w@.])` evita que un email (foo@blue.com)
// dispare al agente cuyo handle coincide con el dominio.
export function detectMentions(body: string, handles: string[]): string[] {
  const hits: { handle: string; idx: number }[] = [];
  for (const h of handles) {
    const re = new RegExp(`(?<![\\w@.])@${h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
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
  "para CUALQUIER documento de PROSA (nda, carta, oficio, contrato, convenio, demanda, dictamen, memo, minuta, acuerdo) o HOJA DE CÁLCULO (tabla, listado, dataset, leads, inventario, presupuesto — lo que iría en xlsx/csv) PROHIBIDO invocar docs-router, el skill oficio, structured_doc, upload_file, mcp__wa__ o cualquier tool de documento (get_page_html, replace_html, set_page_html, add_page…). NO subas archivos ni generes .docx/.xlsx tú. (SALVO la EXCEPCIÓN de PDF/diseño explícito descrita más abajo.)",
  "PROSA → escribe el documento COMPLETO como Markdown DENTRO de un bloque que abre con ```eb-doc y cierra con ```. Usa # para el título, ## para cláusulas, listas y **negritas**.",
  "HOJA DE CÁLCULO / TABLA / DATOS → escribe TODA la tabla como CSV DENTRO de un bloque que abre con ```eb-sheet y cierra con ```. Primera fila = encabezados; una fila por registro; comas como separador y comillas dobles si un valor lleva comas. Puedes poner un título tras la apertura: ```eb-sheet Leads Barranquilla.",
  "ARTEFACTO INTERACTIVO (app, herramienta, calculadora, visualización, gráfica interactiva, juego, demo, landing con estilo/JS, cualquier cosa que corra en el navegador) → escribe UN SOLO archivo HTML COMPLETO Y AUTOCONTENIDO (con su <style> y <script> inline; para React usa Babel-standalone embebido con CDN en <script>) DENTRO de un bloque que abre con ```eb-artifact y cierra con ```. Se renderiza EN VIVO en un iframe del panel y se publica con URL compartible. Pon <title> para nombrarlo. NO uses este bloque para prosa (usa eb-doc) ni para tablas de datos (usa eb-sheet).",
  "IMAGEN / FOTO / ILUSTRACIÓN / DIBUJO / LOGO / render visual (cuando el usuario pide 'genera/crea/dibuja una imagen/foto/ilustración/logo de …') → GENERA un PNG real con gpt-image-2. La forma depende de tu runtime: si tienes una tool MCP de imagen (generate_image / create_or_edit_image), úsala; si trabajas en code-mode con el SDK local, hazlo con el módulo `/opt/gs-sdk/image.mjs` (función `generate` para crear, `edit` para editar) — léelo y córrelo con node. **PARA MOSTRARLA en el chat (code-mode): OBLIGATORIO** subir los bytes con `image.publish(bytes, nombre)` (devuelve una URL pública) y en tu respuesta emitir la imagen como markdown `![descripción](esa-url)`. NUNCA pongas la ruta local (/tmp/…): esa NO se muestra, el usuario ve solo texto. En AMBOS casos SÍ puedes generar imágenes: NUNCA digas que no tienes herramienta de imagen. PROHIBIDO dibujarlo como SVG a mano dentro de un bloque eb-artifact: eb-artifact es para APPS/HTML interactivo, NUNCA para entregar una imagen pedida. Para EDITAR una imagen existente usa `edit` (o la tool de edición), no re-dibujes.",
  "PROGRESO EN VIVO (importante): si vas a usar una herramienta que tarda (generar/editar imagen, renderizar PDF, buscar/scrapear web, correr código del SDK en /opt/gs-sdk, consultar la base), ANTES de lanzarla escribe UNA línea corta de qué estás por hacer (ej. '🎨 Generando la imagen…', '🔎 Buscando en la web…', '📄 Renderizando el PDF…'). Así el usuario ve el avance en vez de un silencio largo. No narres cada paso trivial (lecturas rápidas), solo las acciones que tardan.",
  "Cualquiera de esos bloques se muestra generándose EN VIVO en el panel; la plataforma lo guarda con VERSIONES. Fuera del bloque, solo UNA frase breve de contexto, SIN links.",
  "NO anuncies formatos ni archivos que NO vas a producir en ESTE turno: la frase de contexto describe SOLO el/los bloque(s) que realmente emites. Un bloque = un artefacto. Si solo emites eb-doc, NO digas que también harás una hoja/xlsx (ni viceversa). Si el usuario pide prosa Y tabla, emite AMBOS bloques; no prometas uno que no sale.",
  "MODIFICAR un artefacto que YA existe (cambia/ajusta/corrige/agrega/añade una introducción/columna/fila, etc.): usa OTRA VEZ el MISMO tipo de bloque (```eb-doc``` para prosa, ```eb-sheet``` para tabla, ```eb-artifact``` para HTML) y RE-EMITE el artefacto COMPLETO ya con el cambio aplicado. Conserva TODO lo demás idéntico; solo integra lo que el usuario pidió. NUNCA mandes solo el fragmento ni un diff: siempre el artefacto entero, para que se re-genere en vivo.",
  "EXCEPCIONES (→ usa las skills/tools normales, NO un bloque eb-doc): (a) documentos con membrete de marca fijo; (b) presentaciones (pptx); (c) cuando el usuario pide EXPLÍCITAMENTE un PDF, o un documento 'con diseño'/'vistoso'/'maquetado'/'bonito' → NO lo entregues como eb-doc (eso baja como .docx sin diseño): usa las tools/skills de PDF avanzadas (docs-router / structured_doc / el generador de PDF con diseño de EasyBits) para producir el PDF real y entregar su enlace. La regla 'toda prosa → eb-doc' aplica al documento de prosa por DEFECTO; una petición explícita de PDF/diseño la manda a esas tools. Toda tabla/datos → eb-sheet.",
].join(" ");

// Si el hilo YA tiene un artefacto, al MODIFICAR el agente re-emite el artefacto COMPLETO
// (misma experiencia de streaming que al crear). Para que pueda hacerlo con fidelidad —
// aunque el worker haya reciclado su sesión — le inyectamos el contenido ACTUAL (la verdad
// local) en el TEXTO del turno. Va en el texto, NO en el system prompt: cambia por turno,
// y el system prompt de la sesión persistente se fija al arrancar (un valor variable ahí
// forzaría cold-restart). El BASE estable (EB_DOC_STREAM_GUARDRAIL) sí va en
// appendSystemPrompt (idéntico todos los turnos → persistencia-safe). Vacío si no hay artefacto.
function artifactDocHint(currentDoc?: { kind: "doc" | "sheet" | "artifact"; md: string; src?: string | null } | null): string {
  const md = currentDoc?.md.trim();
  if (!md) return "";
  const kind = currentDoc!.kind;
  const fence = kind === "sheet" ? "eb-sheet" : kind === "artifact" ? "eb-artifact" : "eb-doc";
  const noun =
    kind === "sheet" ? "esta hoja de cálculo (CSV)" : kind === "artifact" ? "este artefacto (HTML autocontenido)" : "este documento";
  const lang = kind === "sheet" ? "CSV" : kind === "artifact" ? "HTML" : "Markdown";
  // Enlace público YA emitido por la plataforma al publicar el artefacto (columna
  // gc_artifacts.src). Se lo damos al agente para que, si el usuario pide "el link"/
  // "publícalo"/"compártelo", lo entregue TAL CUAL en vez de decir que no puede (antes
  // se disculpaba e inventaba que "no tengo tool para crear URLs" — incidente 2026-07-23).
  const src = currentDoc!.src?.trim();
  const linkLine =
    kind === "artifact" && src
      ? `Este artefacto YA está publicado; su enlace compartible es: ${src} . ` +
        `Si el usuario pide el link / que lo publiques / que lo compartas, entrégaselo TAL CUAL (no digas que no puedes ni inventes otra URL). `
      : "";
  return (
    `[Contexto del hilo — ARTEFACTO ACTUAL. En esta conversación ya existe ${noun}. ` +
    linkLine +
    `Si el usuario pide modificarlo (cambiar, ajustar, corregir, agregar/añadir algo), ` +
    `RE-EMITE el artefacto COMPLETO en un bloque \`\`\`${fence} con el cambio ya integrado y todo ` +
    `lo demás idéntico. Este es su contenido actual en ${lang}:\n\n\`\`\`\n${md}\n\`\`\`]\n\n`
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
  currentDoc?: { kind: "doc" | "sheet" | "artifact"; md: string; src?: string | null } | null
): Promise<string> {
  if (agent.backend.kind !== "fleet") {
    // Sin SSE todavía: colecta el reply completo y lo emite de un tirón (el cliente
    // ya lo ve aterrizar). Cuando exista un webhook A2A real, aquí va message/stream.
    const full = await callAgentBackend(agent, groupId, sender, text, parts);
    if (full) await onChunk(full);
    return full;
  }
  const persona = agent.systemPrompt?.trim() || null;
  // Cutover: si GHOSTY_RUNTIME_URL está seteada → runtime nativo de Studio (HMAC,
  // co-locado, sin refresh de token); si no → EasyBits (fallback). Ver
  // server/ghosty-runtime.server.ts.
  const { nativeRuntimeBase, partnerHeaders } = await import("./server/ghosty-runtime.server");
  const native = await nativeRuntimeBase();
  const base = native ?? process.env.EASYBITS_BASE_URL ?? "https://www.easybits.cloud";
  // docHint (contexto por-doc del turno) va PRIMERO en el texto; el system prompt
  // queda estable (base) → la sesión persistente del worker no se rompe al cambiar doc.
  const docHint = artifactDocHint(currentDoc);
  // La persona por-agente va en la CAPA SYSTEM (appendSystemPrompt), NUNCA en el texto
  // del usuario. Antes se anteponía como `[Instrucciones para X: …]` dentro del mensaje;
  // el modelo lo leía como instrucciones incrustadas y lo rechazaba como intento de
  // inyección de prompt (incidente 2026-07-12 en Teams). El texto solo lleva el turno.
  const outText = docHint + text;
  try {
    // `parts` = FileParts A2A (media); EasyBits los normaliza por MIME (Slice E1).
    // configGroupId "teams" = unidad de config ESTABLE de este canal en EasyBits
    // (tools + comportamiento por-Teams via groupConfigs["teams"]); sin él la config
    // caería por-conversación (groupId) → solo el default del agente.
    const streamBody = JSON.stringify({
      groupId,
      configGroupId: "teams",
      sender: sender || "invitado",
      text: outText,
      parts,
      // Persona por-agente + guardrail eb-doc, ambos en la capa system. EasyBits los
      // mergea al system del worker (claude-worker) o al marco de confianza del turno
      // (ghosty-gc). Nunca en el texto del usuario → nunca se lee como inyección.
      appendSystemPrompt: [
        persona ? `[Persona de ${agent.name}]\n${persona}` : null,
        EB_DOC_STREAM_GUARDRAIL,
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
    const url = `${base}/api/v2/fleet-agents/${(agent.backend as { id: string }).id}/message-stream`;
    const doStream = (tok: string) =>
      fetch(url, {
        method: "POST",
        headers: native
          ? partnerHeaders(streamBody) // nativo: firma HMAC del body
          : { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
        body: streamBody,
      });
    // SELF-HEAL (solo EasyBits): el fleet_token (pool) CADUCA. Ante 401 refrescamos el
    // OAuth + re-obtenemos el token fresco y reintentamos UNA vez (incidente 2026-07-14).
    // En el runtime nativo NO aplica: la HMAC no caduca por turno.
    let res = await doStream(agent.backend.token);
    if (!native && res.status === 401) {
      const fresh = await refreshFleetToken((agent.backend as { id: string }).id);
      if (fresh) res = await doStream(fresh);
    }
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
  create_document: { ing: "Creando el documento", done: "Creé el documento" },
  structured_doc: { ing: "Generando el documento", done: "Generé el documento" },
  set_section_html: { ing: "Editando el documento", done: "Edité el documento" },
  set_page_html: { ing: "Editando el documento", done: "Edité el documento" },
  update_document: { ing: "Editando el documento", done: "Edité el documento" },
  insert_page: { ing: "Agregando una página", done: "Agregué una página" },
  reorder_pages: { ing: "Reordenando páginas", done: "Reordené las páginas" },
  clone_document: { ing: "Clonando el documento", done: "Cloné el documento" },
  apply_brand_kit: { ing: "Aplicando la marca", done: "Apliqué la marca" },
  change_document_format: { ing: "Cambiando el formato", done: "Cambié el formato" },
  create_or_edit_image: { ing: "Editando una imagen", done: "Edité una imagen" },
  edit_image: { ing: "Editando una imagen", done: "Edité una imagen" },
  upload_file: { ing: "Subiendo el documento", done: "Subí el documento" },
  create_share_link: { ing: "Generando el link", done: "Generé un link para compartir" },
  render_url: { ing: "Renderizando a PDF", done: "Generé el PDF" },
  render_html: { ing: "Renderizando a PDF", done: "Generé el PDF" },
  office_to_pdf: { ing: "Convirtiendo a PDF", done: "Convertí a PDF" },
  deploy_document: { ing: "Publicando el documento", done: "Publiqué el documento" },
  create_website: { ing: "Creando el sitio", done: "Creé el sitio" },
  WebSearch: { ing: "Buscando en la web", done: "Busqué en la web" },
  research_search: { ing: "Investigando en la web", done: "Investigué en la web" },
  // El agente redacta docs invocando un Skill (oficio/xlsx/pptx/doc-remix) → la acción
  // visible = "Redacté el documento" (antes solo se veía "Subió", el paso final).
  Skill: { ing: "Redactando el documento", done: "Redacté el documento" },
  artifact_create: { ing: "Redactando el documento", done: "Redacté el documento" },
  artifact_update: { ing: "Actualizando el documento", done: "Actualicé el documento" },
  // Feedback de acciones significativas (visibilidad estilo Quick): lecturas de datos,
  // consultas a la base, y envíos. Se ocultan las lecturas de plumbing (Bash/Glob/Grep/get_).
  Read: { ing: "Leyendo un archivo", done: "Leí un archivo" },
  WebFetch: { ing: "Leyendo una página", done: "Leí una página" },
  research_scrape: { ing: "Leyendo una página", done: "Leí una página" },
  db_query: { ing: "Consultando la base", done: "Consulté la base" },
  db_select: { ing: "Consultando la base", done: "Consulté la base" },
  db_get: { ing: "Consultando la base", done: "Consulté la base" },
  db_list: { ing: "Consultando la base", done: "Consulté la base" },
  db_exec: { ing: "Escribiendo en la base", done: "Escribí en la base" },
  db_create: { ing: "Escribiendo en la base", done: "Escribí en la base" },
  db_import: { ing: "Importando datos", done: "Importé datos" },
  send_message: { ing: "Enviando el mensaje", done: "Envié el mensaje" },
  send_email: { ing: "Enviando el correo", done: "Envié el correo" },
  send_broadcast: { ing: "Enviando el broadcast", done: "Envié el broadcast" },
  create_form: { ing: "Creando el formulario", done: "Creé el formulario" },
  create_payment_link: { ing: "Generando el link de pago", done: "Generé el link de pago" },
  create_quotation: { ing: "Preparando la cotización", done: "Preparé la cotización" },
  fast_quotation: { ing: "Preparando la cotización", done: "Preparé la cotización" },
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
  // Artefacto ACTUAL del hilo (doc/sheet + contenido) → se inyecta al turno para re-emisión
  // completa al editar.
  currentDoc?: { kind: "doc" | "sheet" | "artifact"; md: string; src?: string | null } | null;
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
      // eb-doc/eb-sheet no llaman tools → sin esto el checklist quedaría vacío. Sintetiza una
      // entrada en cuanto aparece el bloque ("Redactó el documento" / "Generó la hoja").
      if (!ebDocSeen && /```eb-(doc|sheet)/.test(acc)) {
        ebDocSeen = true;
        anyActivity = true;
        const isSheet = /```eb-sheet/.test(acc);
        const label = isSheet
          ? { ing: "Generando la hoja", done: "Generé la hoja" }
          : { ing: "Redactando el documento", done: "Redacté el documento" };
        if (!tools.some((t) => t.done === label.done)) tools.push(label);
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
    reply = await callAgentBackendStream(opts.agent, opts.groupId, opts.sender, opts.text, onChunk, opts.parts ?? [], onTool, opts.currentDoc);
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
  // fleet: la persona por-agente va en la CAPA SYSTEM (appendSystemPrompt), NO en el
  // texto. Meterla en el texto (`[Instrucciones para X: …]`) hacía que el modelo la
  // leyera como inyección de prompt y la rechazara. El texto solo lleva el turno.
  const { nativeRuntimeBase, partnerHeaders } = await import("./server/ghosty-runtime.server");
  const native = await nativeRuntimeBase();
  const base = native ?? process.env.EASYBITS_BASE_URL ?? "https://www.easybits.cloud";
  try {
    // configGroupId "teams" = unidad de config estable del canal (ver message-stream).
    const msgBody = JSON.stringify({
      groupId,
      configGroupId: "teams",
      sender: sender || "invitado",
      text,
      parts,
      appendSystemPrompt: [
        persona ? `[Persona de ${agent.name}]\n${persona}` : null,
        EB_DOC_STREAM_GUARDRAIL,
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
    const url = `${base}/api/v2/fleet-agents/${(agent.backend as { id: string }).id}/message`;
    const doMsg = (tok: string) =>
      fetch(url, {
        method: "POST",
        headers: native
          ? partnerHeaders(msgBody)
          : { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
        body: msgBody,
      });
    // Self-heal en 401 solo EasyBits (la HMAC nativa no caduca).
    let res = await doMsg(agent.backend.token);
    if (!native && res.status === 401) {
      const fresh = await refreshFleetToken((agent.backend as { id: string }).id);
      if (fresh) res = await doMsg(fresh);
    }
    if (!res.ok) throw new Error(`fleet ${res.status}: ${await res.text()}`);
    return ((await res.json()) as { reply?: string }).reply ?? "(sin respuesta)";
  } catch (e) {
    return `⚠️ No pude contactar a @${agent.handle}: ${e instanceof Error ? e.message : e}`;
  }
}
