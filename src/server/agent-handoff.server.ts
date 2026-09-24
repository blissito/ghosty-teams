// ── Relevo entre agentes: un @ de un agente a otro lo despierta en el MISMO hilo ──
//
// Nació en #divi de descti (2026-09-24): «@ghosty coordina con @fable…» despertaba a los DOS
// en paralelo con el mismo pedido, cada uno hacía su documento completo, y el «@fable,
// súmate» que Ghosty escribió no llegaba a nadie — la mención de un agente sólo notificaba
// a personas (`mentions.server.ts`). Dos entregables duplicados y cero coordinación.
//
// El modelo es el del resto del ecosistema (Grok Bot con su «chief of staff», Slack con el
// orquestador que delega en especialistas, hermes-agent/openclaw en Discord):
//
//   1. Un pedido de COORDINACIÓN («@a coordina con @b») despierta sólo al primero, que dirige.
//   2. El relevo es EXPLÍCITO: un @agente en la respuesta final del agente (no en sus pasos,
//      no dentro de un documento) lo despierta en el hilo, con los adjuntos del hilo.
//   3. Tope de relevos por hilo que sólo resetea una PERSONA escribiendo: sin él, dos
//      agentes corteses se agradecen el uno al otro hasta vaciar la bolsa (openclaw #58789).
//
// El despertar va por la cola durable de `wakeups.server.ts` (clave `handoff:`), igual que
// la estafeta de la Software Factory: si hay turno en vuelo del destinatario se difiere, y
// un reinicio no pierde el relevo.
import type { Channel } from "../db.server";
import { dbq } from "../dbq.server";

/** Relevos agente→agente por hilo entre dos mensajes de una persona. */
export const MAX_HANDOFFS = 4;
const FLEET_THREAD = "flow"; // la misma clave de memoria por room que usa chat.ts

// Verbos con los que una persona pide que un agente trabaje CON otro, no en paralelo.
const COORDINATION_RE =
  /\b(co?ord[ií]n\w*|deleg\w*|p[ií]dele\w*|junto con|en conjunto con|trabaj\w* con|colabor\w* con|ap[oó]y\w* (en|de|con)|con (la )?ayuda de|reparte\w*|repart\w* con)\b/i;

/**
 * Qué agentes arrancan con un mensaje de persona. Con varios @agente y un verbo de
 * coordinación, sólo el PRIMERO: él dirige y llama a los demás cuando los necesite.
 * «@a @b ¿qué opinan?» sigue despertando a los dos, que es lo que se pide ahí.
 */
export function pickRespondents(body: string, mentioned: string[]): string[] {
  if (mentioned.length > 1 && COORDINATION_RE.test(body)) return mentioned.slice(0, 1);
  return mentioned;
}

/**
 * Lo que se le antepone al turno de un agente cuando el mensaje nombra a OTROS agentes:
 * cómo se les habla. Sin esto el agente escribe «@fable, súmate» en sus pasos, que nadie lee.
 */
export async function coordinationHint(body: string, self: string, agentHandles: string[]): Promise<string> {
  const { detectMentions } = await import("../agents.server");
  const otros = detectMentions(body, agentHandles).filter((h) => h !== self);
  if (!otros.length) return "";
  const lista = otros.map((h) => `@${h}`).join(", ");
  const dirige = COORDINATION_RE.test(body)
    ? `Tú diriges este trabajo: ${lista} NO arrancó por su cuenta y no va a hacer nada hasta que lo llames.`
    : `${lista} también está en este room.`;
  return (
    `[Plataforma — trabajo con otros agentes] ${dirige} ` +
    `Para encargarle algo, menciónalo (${lista}) en tu RESPUESTA FINAL con un encargo concreto ` +
    `(qué parte, sobre qué documento, qué te debe devolver). Esa mención lo despierta en este mismo hilo con los mismos adjuntos; ` +
    `una mención en tus pasos o dentro de un documento NO lo despierta. Cuando termine te regresa el turno si te menciona. ` +
    `No lo menciones para agradecer ni para cerrar: cada @ es un turno más.\n\n`
  );
}

/**
 * Despierta a los agentes que `reply` menciona, en el hilo `parentId`. Devuelve el aviso
 * para la burbuja cuando el tope cortó un relevo ("" si no hubo nada que decir).
 *
 * `invokerSub` es la PERSONA que originó la cadena: los relevos corren con su autoridad y
 * contra su bolsa, igual que el turno que los pidió.
 */
export async function handoffFromReply(p: {
  ns: string;
  channel: Pick<Channel, "id" | "slug">;
  parentId: number | null;
  topic: string;
  fromHandle: string;
  fromName: string;
  reply: string;
  invokerSub: string;
  origin: string;
}): Promise<string> {
  if (p.parentId == null || !p.invokerSub || !p.reply.trim()) return "";
  const { resolvedAgents, detectMentions, agentGroupId } = await import("../agents.server");
  const eb = await import("../lib/ebdoc");
  // La PROSA, con el mismo criterio que las notificaciones: un @ dentro de un documento, de
  // los pasos o de un bloque de herramientas no es un relevo.
  const prosa = [eb.stripEbAudio, eb.stripEbFile, eb.stripAskUser]
    .reduce((s, f) => f(s), eb.bubbleWithoutEbDoc(p.reply))
    .trim();
  if (!prosa) return "";
  const agents = await resolvedAgents();
  const users = await import("../users.server");
  const userHandles = (await users.listUsers().catch(() => [])).map((u) => u.handle).filter(Boolean) as string[];
  const targets = detectMentions(prosa, agents.map((a) => a.handle), userHandles).filter((h) => h !== p.fromHandle);
  if (!targets.length) return "";

  // Tope: relevos de este hilo desde el último mensaje de una PERSONA en él.
  const prefix = `handoff:${p.channel.id}:${p.parentId}:`;
  const [human] = await dbq(
    `SELECT MAX(created_at) AS t FROM gc_messages WHERE (id = ? OR parent_id = ?) AND sender_sub IS NOT NULL`,
    [p.parentId, p.parentId],
  );
  const since = Number(human?.t ?? 0);
  const [used] = await dbq(
    `SELECT COUNT(*) AS n FROM gt_agent_wakeups WHERE key LIKE ? AND due_at >= ?`,
    [`${prefix}%`, since],
  );
  let budget = MAX_HANDOFFS - Number(used?.n ?? 0);

  const { enqueueWakeup, mintWakeRef, kickWakeups } = await import("./wakeups.server");
  const cortados: string[] = [];
  let encolados = 0;
  for (const to of targets) {
    if (budget <= 0) { cortados.push(to); continue; }
    const agent = agents.find((a) => a.handle === to);
    if (!agent) continue;
    const groupId = await agentGroupId(agent, `${p.channel.slug}-${FLEET_THREAD}`);
    const ok = await enqueueWakeup({
      key: `${prefix}${to}:${Date.now()}`,
      ref: mintWakeRef({
        sub: p.invokerSub,
        ns: p.ns,
        groupId,
        dest: { channelId: p.channel.id, parentId: p.parentId, topic: p.topic, handle: agent.handle, name: agent.name, avatar: agent.avatar },
      }),
      cause: p.fromHandle,
      text: `${p.fromName} (@${p.fromHandle}) te escribió en este hilo:\n\n${prosa}`,
      origin: p.origin,
      dueAt: Math.floor(Date.now() / 1000),
    });
    if (ok) { budget--; encolados++; }
  }
  if (encolados) kickWakeups(p.ns);
  console.log(`[handoff] ${p.fromHandle} → ${targets.join(",")} hilo=${p.parentId} encolados=${encolados} cortados=${cortados.length}`);
  return cortados.length
    ? `⚠️ No desperté a ${cortados.map((h) => `@${h}`).join(", ")}: este hilo ya lleva ${MAX_HANDOFFS} relevos entre agentes sin que escriba una persona. Menciónalo tú para seguir.`
    : "";
}

/**
 * El texto y los adjuntos con que arranca el agente relevado. Va con el mensaje raíz del
 * hilo y sus archivos: el relevado corre en su memoria del room, que no vio este pedido.
 */
export async function handoffTurnInput(parentId: number | null, from: string, text: string) {
  const db = await import("../db.server");
  const { manifiestoAdjuntos, buildMediaParts } = await import("../agents.server");
  let ctx = "";
  let atts: { fileId: string; mime: string | null; size: number | null; name: string | null }[] = [];
  if (parentId != null) {
    const root = await db.getMessage(parentId).catch(() => null);
    if (root) {
      const [full] = await db.attachAttachments([root]).catch(() => [root]);
      atts = (full?.attachments ?? []).map((a) => ({ fileId: a.file_id, mime: a.mime, size: a.size, name: a.name }));
      const body = (root.body ?? "").trim();
      if (body) ctx = `[Pedido original del hilo — ${root.sender || "una persona"}]\n${body.length > 3000 ? body.slice(0, 3000) + "…" : body}\n\n`;
    }
  }
  const head =
    `🤝 Relevo de @${from}. Otro agente del equipo te pasa trabajo en este hilo; la persona que lo pidió lee lo mismo que tú. ` +
    `Haz tu parte y entrégala aquí. Si necesitas que @${from} siga (integrar, revisar), menciónalo en tu respuesta final; ` +
    `si ya quedó, NO lo menciones — cada @ lo despierta.\n\n`;
  const full = head + manifiestoAdjuntos(atts, { reentrega: true, ambito: "hilo" }) + ctx + text;
  const parts = await buildMediaParts(atts, { forceUri: true });
  return { text: full, parts };
}
