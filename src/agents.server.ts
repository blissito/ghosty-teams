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
  parts: MediaPart[] = []
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
      body: JSON.stringify({ groupId, sender: sender || "invitado", text: outText, parts }),
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
        let ev: { type?: string; value?: string; message?: string };
        try {
          ev = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        if (ev.type === "chunk" && ev.value) {
          streamed += ev.value;
          await onChunk(ev.value);
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

// Llama al backend del agente y devuelve su respuesta en texto.
export async function callAgentBackend(
  agent: ResolvedAgent,
  groupId: string,
  sender: string,
  text: string
): Promise<string> {
  const persona = agent.systemPrompt?.trim() || null;
  if (agent.backend.kind === "webhook") {
    try {
      // Webhook: contrato que SÍ controlamos → mandamos identidad + persona explícita
      // (el bot rutea su prompt por agente), además del texto crudo.
      const res = await fetch(agent.backend.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          groupId,
          sender,
          text,
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
      body: JSON.stringify({ groupId, sender: sender || "invitado", text: outText }),
    });
    if (!res.ok) throw new Error(`fleet ${res.status}: ${await res.text()}`);
    return ((await res.json()) as { reply?: string }).reply ?? "(sin respuesta)";
  } catch (e) {
    return `⚠️ No pude contactar a @${agent.handle}: ${e instanceof Error ? e.message : e}`;
  }
}
