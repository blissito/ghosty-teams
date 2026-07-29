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
        });
        return { ok: true, id: r.id, when: rem.humanDate(dueAt, tz), tz, repeat, email: args.email === true };
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
          reminders: list.map((r) => ({ id: r.id, text: r.text, when: rem.humanDate(r.dueAt, r.tz), repeat: r.repeat, email: r.email })),
        };
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
  ];
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
