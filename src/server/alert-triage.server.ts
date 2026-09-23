// ── Cada alerta nueva de #soporte la revisa @ghosty en su hilo ──────────────
//
// Las alertas entran por `api/internal/alert` como mensaje de SISTEMA: no pasan por
// `askAgent` y no abren turno, así que se quedaban sin que nadie las mirara. Aquí se encola
// un despertador (`gt_agent_wakeups`) que abre un turno de @ghosty en el hilo de la alerta
// con un encargo fijo: ¿es real o ruido?, causa con archivo:línea y, si el arreglo es claro,
// un PR en borrador.
//
// Una revisión por PROBLEMA, no por aviso: gs deduplica 6 h en memoria (y un restart lo
// reinicia), así que un bug recurrente llegaría varias veces al día. La `key` del
// despertador lleva la huella del problema + el día, y `enqueueWakeup` es idempotente por
// `key`: se revisa una vez al día.

import { createHash } from "node:crypto";

/** Las recuperaciones («studio se recuperó») no tienen nada que revisar. */
export function worthTriage(title: string): boolean {
  return !/se recuper[óo]/i.test(title);
}

/** Huella del problema: el título + la primera línea del detalle (el error, sin el stack). */
export function alertKey(title: string, detail: string | undefined, now = Date.now()): string {
  const firstLine = (detail ?? "").split("\n").find((l) => l.trim())?.trim() ?? "";
  const hash = createHash("sha1").update(`${title}\n${firstLine}`).digest("hex").slice(0, 16);
  const day = new Date(now).toISOString().slice(0, 10);
  return `alert:${hash}:${day}`;
}

const ENCARGO =
  "Revisa esta alerta de la plataforma: ¿es real o ruido? Si es real: causa probable con " +
  "archivo:línea y el arreglo. Si el arreglo es claro y chico, abre un PR en borrador (flujo " +
  "de code-change). Si es ruido o ya está resuelto, dilo en una línea. Máximo 8 renglones.";

export async function enqueueAlertTriage(a: {
  ns: string;
  roomId: number;
  alertId: number;
  title: string;
  detail?: string;
  origin: string;
}): Promise<boolean> {
  if (!worthTriage(a.title)) return false;
  const { dbq } = await import("../dbq.server");
  // El despertador necesita una persona real: sus conectores (GitHub incluido) son con los
  // que trabaja el agente. El dueño del espacio.
  const [owner] = await dbq("SELECT sub FROM gc_users WHERE is_owner = 1 AND COALESCE(banned,0) = 0 LIMIT 1", []);
  const sub = typeof owner?.sub === "string" ? owner.sub : "";
  if (!sub) return false;
  const { resolvedAgents, agentGroupId } = await import("../agents.server");
  const ghosty = (await resolvedAgents()).find((x) => x.handle === "ghosty");
  if (!ghosty) return false;
  // Conversación PROPIA: la revisión de alertas no se mezcla con la memoria del room.
  const groupId = await agentGroupId(ghosty, "soporte-alertas");
  const { enqueueWakeup, mintWakeRef, armWakeups } = await import("./wakeups.server");
  const ok = await enqueueWakeup({
    key: alertKey(a.title, a.detail),
    ref: mintWakeRef({
      sub,
      ns: a.ns,
      groupId,
      dest: { channelId: a.roomId, parentId: a.alertId, topic: "general", handle: "ghosty", name: ghosty.name, avatar: ghosty.avatar },
    }),
    cause: "alerta en #soporte",
    text: `${ENCARGO}\n\nLa alerta:\n**${a.title}**\n${(a.detail ?? "").slice(0, 1500)}`,
    origin: a.origin,
    dueAt: Math.floor(Date.now() / 1000) + 10,
  });
  if (ok) armWakeups(a.ns);
  return ok;
}
