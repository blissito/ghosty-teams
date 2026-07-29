// Tools NATIVAS del producto: las que no vienen de un conector OAuth y por lo tanto
// existen para todo el mundo, sin conectar nada. Mismo contrato que un conector
// (ConnectorTool), así que el modelo no distingue una de otra.
//
// Existen porque el discovery de tools.server.ts arranca de los conectores CONECTADOS
// del usuario: un usuario sin integraciones veía CERO tools, y por eso el agente
// improvisaba ("programa recordatorios en tu cuenta de claude.ai") en vez de usar algo.
//
// El `dest` (canal o DM del turno) viaja en el token-capacidad, no en los argumentos:
// el agente no puede dejarle un recordatorio a otro ni en otro canal.
import type { ConnectorTool } from "./impl";
// El destino se define donde se FIRMA (tool-token), que es lo que lo hace confiable.
export type { ToolDest } from "./tool-token.server";
import type { ToolDest } from "./tool-token.server";

const REPEATS = ["daily", "weekly", "monthly"] as const;

export function nativeTools(dest: ToolDest | null): ConnectorTool[] {
  return [
    {
      name: "reminder_create",
      description:
        "Programa un recordatorio que Ghosty publicará en esta conversación a la hora indicada. " +
        "Úsalo siempre que te pidan recordar, avisar o programar algo — es una capacidad REAL de Ghosty Teams. " +
        "`when` va en hora LOCAL del usuario (YYYY-MM-DDTHH:mm); resuelve tú las expresiones relativas " +
        "('mañana', 'el 1 de agosto', 'en 2 horas') usando la fecha actual antes de llamar.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Qué recordar, en las palabras del usuario" },
          when: { type: "string", description: "Fecha y hora local: YYYY-MM-DDTHH:mm (sin hora → 09:00)" },
          repeat: { type: "string", enum: [...REPEATS], description: "Repetición; omítelo si es una sola vez" },
          email: { type: "boolean", description: "true si además quiere el aviso por correo. PREGÚNTASELO antes de programar; si no contesta, false" },
          emailCc: { type: "array", items: { type: "string" }, description: "copia del correo a otras direcciones (máx 5). Sólo si te las dictan explícitamente" },
        },
        required: ["text", "when"],
      },
      handler: async (sub, args) => {
        if (!dest) return { ok: false, error: "no puedo programar recordatorios fuera de una conversación" };
        const rem = await import("../reminders.server");
        const text = String(args.text ?? "").trim();
        if (!text) return { ok: false, error: "falta qué recordar" };
        const tz = await tzOf(sub);
        const dueAt = rem.parseLocal(String(args.when ?? ""), tz);
        if (!dueAt) return { ok: false, error: "fecha no entendida; usa YYYY-MM-DDTHH:mm" };
        // Una fecha ya pasada casi siempre es un año/mes mal resuelto por el modelo:
        // dispararlo de inmediato sería peor que decirlo.
        if (dueAt * 1000 < Date.now() - 60_000) {
          return { ok: false, error: `esa fecha ya pasó (${rem.humanDate(dueAt, tz)}); confirma el día con el usuario` };
        }
        const repeat = REPEATS.includes(args.repeat as never) ? (args.repeat as (typeof REPEATS)[number]) : null;
        const r = await rem.createReminder({
          ownerSub: sub,
          channelId: dest.channelId ?? null,
          dmId: dest.dmId ?? null,
          topic: dest.topic || "general",
          agentHandle: dest.handle || "ghosty",
          agentName: dest.name || "Ghosty",
          agentAvatar: dest.avatar || "",
          text,
          dueAt,
          repeat,
          tz,
          email: args.email === true,
          emailCc: cleanCc(args.emailCc),
        });
        return { ok: true, id: r.id, when: rem.humanDate(dueAt, tz), tz, repeat, email: r.email, emailCc: r.emailCc };
      },
    },
    {
      name: "reminder_list",
      description: "Lista los recordatorios pendientes de quien te está hablando.",
      inputSchema: { type: "object", properties: {} },
      handler: async (sub) => {
        const rem = await import("../reminders.server");
        const list = await rem.listReminders(sub);
        return {
          ok: true,
          reminders: list.map((r) => ({ id: r.id, text: r.text, when: rem.humanDate(r.dueAt, r.tz), repeat: r.repeat, email: r.email, emailCc: r.emailCc })),
        };
      },
    },
    {
      name: "reminder_update",
      description:
        "Edita un recordatorio pendiente (sácale el id con reminder_list). Manda SÓLO lo que cambia: " +
        "activarle el correo no debe moverle la fecha. Úsalo en vez de cancelar y recrear.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "id del recordatorio" },
          text: { type: "string", description: "nuevo texto" },
          emailCc: { type: "array", items: { type: "string" }, description: "reemplaza la lista de copias; [] la vacía" },
          when: { type: "string", description: "nueva fecha y hora local YYYY-MM-DDTHH:mm" },
          repeat: { type: "string", enum: [...REPEATS, "none"], description: "'none' quita la repetición" },
          email: { type: "boolean", description: "true = además por correo; false = sólo en el chat" },
        },
        required: ["id"],
      },
      handler: async (sub, args) => {
        const rem = await import("../reminders.server");
        const tz = await tzOf(sub);
        const patch: { text?: string; dueAt?: number; repeat?: (typeof REPEATS)[number] | null; email?: boolean; emailCc?: string[] } = {};
        if (typeof args.text === "string" && args.text.trim()) patch.text = args.text.trim();
        if (typeof args.when === "string" && args.when) {
          const due = rem.parseLocal(args.when, tz);
          if (!due) return { ok: false, error: "fecha no entendida; usa YYYY-MM-DDTHH:mm" };
          if (due * 1000 < Date.now() - 60_000) return { ok: false, error: `esa fecha ya pasó (${rem.humanDate(due, tz)})` };
          patch.dueAt = due;
        }
        if (args.repeat === "none") patch.repeat = null;
        else if (REPEATS.includes(args.repeat as never)) patch.repeat = args.repeat as (typeof REPEATS)[number];
        if (typeof args.email === "boolean") patch.email = args.email;
        if (Array.isArray(args.emailCc)) patch.emailCc = cleanCc(args.emailCc);
        const r = await rem.updateReminder(sub, String(args.id ?? ""), patch);
        if (!r) return { ok: false, error: "no existe, ya disparó, no es tuyo, o no mandaste ningún cambio" };
        return { ok: true, id: r.id, text: r.text, when: rem.humanDate(r.dueAt, r.tz), repeat: r.repeat, email: r.email, emailCc: r.emailCc };
      },
    },
    {
      name: "reminder_cancel",
      description: "Cancela un recordatorio pendiente por su id (sácalo de reminder_list).",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "id del recordatorio" } },
        required: ["id"],
      },
      handler: async (sub, args) => {
        const rem = await import("../reminders.server");
        const ok = await rem.cancelReminder(sub, String(args.id ?? ""));
        return ok ? { ok: true } : { ok: false, error: "no existe, ya disparó, o no es tuyo" };
      },
    },
    // ── Memoria de la conversación ────────────────────────────────────────────
    // No hay `memory_read` a propósito: las notas se inyectan en el texto de cada turno
    // (memoryHint en agents.server.ts), así que el agente ya las tiene delante. Una tool de
    // lectura sería un viaje de red para traer algo que ya está en su contexto.
    {
      name: "memory_write",
      description:
        "Guarda una CONVENCIÓN de esta conversación, para que siga vigente en turnos futuros y en " +
        "otros hilos del mismo room. Úsalo cuando te digan 'de ahora en adelante', 'siempre', " +
        "'recuérdalo' o 'anótalo': formato de los documentos, cómo se llaman las partes, cómo firma " +
        "el despacho, tratamientos. NO guardes aquí el contenido de los documentos (para eso están " +
        "los artefactos y sus versiones), ni datos sensibles que nadie pidió guardar, ni el estado de " +
        "una tarea en curso. Si ya existe una nota parecida, actualízala con `replaces` en vez de " +
        "añadir otra: dos notas que se contradicen es peor que ninguna.",
      inputSchema: {
        type: "object",
        properties: {
          note: { type: "string", description: "La convención, en una frase corta y accionable" },
          replaces: { type: "number", description: "id de la nota que sustituye (el que ves en la memoria del turno)" },
        },
        required: ["note"],
      },
      handler: async (sub, args) => {
        if (!dest) return { ok: false, error: "no puedo guardar memoria fuera de una conversación" };
        const db = await import("../../db.server");
        const scope = db.memoryScopeKey(dest);
        const handle = dest.handle;
        if (!scope || !handle) return { ok: false, error: "no pude identificar la conversación" };

        const note = String(args.note ?? "").trim().replace(/\s+/g, " ");
        if (!note) return { ok: false, error: "la nota viene vacía" };
        if (note.length > db.MEMORY_MAX_CHARS)
          return { ok: false, error: `demasiado larga (máx ${db.MEMORY_MAX_CHARS} caracteres); resúmela` };

        if (args.replaces != null) {
          const ok = await db.updateAgentMemory(Number(args.replaces), scope, handle, note);
          return ok ? { ok: true, id: Number(args.replaces) } : { ok: false, error: "esa nota no existe en esta conversación" };
        }
        const actuales = await db.listAgentMemory(scope, handle);
        if (actuales.length >= db.MEMORY_MAX_NOTES)
          return {
            ok: false,
            // Falla en vez de podar: perder una convención sin avisar es peor que negarse.
            error: `la memoria está llena (${db.MEMORY_MAX_NOTES} notas). Borra alguna con memory_forget o sustituye una con \`replaces\``,
          };
        const id = await db.addAgentMemory(scope, handle, note, sub);
        return { ok: true, id };
      },
    },
    {
      name: "memory_forget",
      description:
        "Borra una nota de la memoria de esta conversación por su id (el que ves en el bloque de " +
        "memoria del turno). Úsalo cuando una convención deje de aplicar o te digan que la olvides.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number", description: "id de la nota" } },
        required: ["id"],
      },
      handler: async (_sub, args) => {
        if (!dest) return { ok: false, error: "no puedo borrar memoria fuera de una conversación" };
        const db = await import("../../db.server");
        const scope = db.memoryScopeKey(dest);
        const handle = dest.handle;
        if (!scope || !handle) return { ok: false, error: "no pude identificar la conversación" };
        const ok = await db.deleteAgentMemory(Number(args.id ?? 0), scope, handle);
        return ok ? { ok: true } : { ok: false, error: "esa nota no existe en esta conversación" };
      },
    },
  ];
}

/**
 * Direcciones de copia. El tope de 5 y el filtro no son burocracia: este correo sale del
 * dominio del producto con texto que escribió un usuario, así que es un canal de envío a
 * terceros y no debe poder convertirse en una lista de difusión.
 */
function cleanCc(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const ok = v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim().toLowerCase())
    .filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(x));
  return Array.from(new Set(ok)).slice(0, 5);
}

/** Zona horaria del usuario (capturada del navegador). Sin ella, la del negocio. */
async function tzOf(sub: string): Promise<string> {
  const rem = await import("../reminders.server");
  try {
    const { dbq } = await import("../../dbq.server");
    const rows = await dbq("SELECT tz FROM gc_users WHERE sub=?", [sub]);
    const tz = rows[0]?.tz;
    if (tz && rem.isValidTz(tz)) return tz;
  } catch { /* columna nueva en un tenant sin migrar aún */ }
  return rem.DEFAULT_TZ;
}
