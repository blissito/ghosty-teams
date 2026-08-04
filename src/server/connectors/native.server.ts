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
    // ── Formularios de intake ─────────────────────────────────────────────────
    // El agente dicta el SCHEMA (título y campos); el HTML lo renderiza el servidor.
    // El formulario se publica como artefacto y su liga es /artefacto/<slug>.
    {
      name: "form_create",
      description:
        "Crea un formulario de intake con liga pública para mandarle a un cliente. Las respuestas " +
        "llegan a ESTA conversación como una ficha (documento descargable), una por respuesta. " +
        "Úsalo cuando pidan un cuestionario, un formato de alta, un diagnóstico o recabar datos de " +
        "un tercero que no tiene cuenta aquí. Tú defines los campos; el diseño y la validación los " +
        "pone el sistema — no escribas HTML. Agrupa los campos con `section` (los consecutivos con " +
        "la misma sección forman un paso) y usa `showIf` para preguntas que sólo aplican según una " +
        "respuesta anterior. Devuelve la liga: pásasela al usuario tal cual.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Nombre del formulario, como lo verá quien responde" },
          intro: { type: "string", description: "Una línea de contexto arriba del formulario" },
          thanks: { type: "string", description: "Mensaje al terminar de responder" },
          locale: {
            type: "string",
            enum: ["es", "en"],
            description:
              "Idioma de los botones, avisos y errores del formulario ('Siguiente' vs 'Next'). Ponlo " +
              "en el idioma de quien va a RESPONDER, que suele ser el de la conversación. Por default es.",
          },
          fields: {
            type: "array",
            description: "Los campos, en el orden en que se preguntan",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Clave interna: minúsculas, números y _ (ej. razon_social)" },
                type: {
                  type: "string",
                  enum: ["text", "email", "tel", "textarea", "select", "date", "number", "checkbox", "radio", "file", "matrix"],
                  description:
                    "checkbox=consentimiento; radio=opción única (options, o Sí/No); select=lista; file=archivo; " +
                    "matrix=rejilla (columnas en options, filas en rows, una respuesta por fila)",
                },
                label: { type: "string", description: "La pregunta, como se le muestra a la persona" },
                required: { type: "boolean" },
                placeholder: { type: "string", description: "Pista dentro del campo (en checkbox, la frase de consentimiento)" },
                options: { type: "array", items: { type: "string" }, description: "Opciones de select/radio, o las COLUMNAS de una matrix" },
                rows: { type: "array", items: { type: "string" }, description: "Sólo matrix: las filas" },
                accept: { type: "string", description: "Sólo file: tipos aceptados, ej. '.pdf,.jpg'" },
                showIf: {
                  type: "object",
                  description: "Muestra este campo sólo si otro campo ANTERIOR vale exactamente esto",
                  properties: { field: { type: "string" }, equals: { type: "string" } },
                },
                section: { type: "string", description: "Nombre del paso al que pertenece" },
              },
              required: ["name", "type", "label"],
            },
          },
        },
        required: ["title", "fields"],
      },
      handler: async (sub, args) => {
        if (!dest?.channelId) return { ok: false, error: "los formularios sólo se pueden crear dentro de un canal" };
        const { createForm } = await import("../forms/publish.server");
        const r = await createForm({
          channelId: dest.channelId,
          topic: dest.topic || "general",
          title: String(args.title ?? ""),
          fields: args.fields,
          intro: typeof args.intro === "string" ? args.intro : null,
          thanks: typeof args.thanks === "string" ? args.thanks : null,
          locale: args.locale === "en" ? "en" : "es",
          ownerSub: sub,
          agentHandle: dest.handle,
          agentName: dest.name,
          agentAvatar: dest.avatar,
        });
        if (!r.ok) return r;
        return { ok: true, formId: r.form.id, url: r.url, fields: r.form.fields.length };
      },
    },
    {
      name: "form_update",
      description:
        "Cambia un formulario que ya existe (saca el id con form_list): título, campos, o ciérralo " +
        "con status:'closed' para que deje de recibir respuestas. **La liga NO cambia** — usa esto " +
        "en vez de crear otro formulario, o repartirás dos ligas para lo mismo. `fields` REEMPLAZA " +
        "la lista completa: manda todos los campos, no sólo el nuevo.",
      inputSchema: {
        type: "object",
        properties: {
          formId: { type: "string" },
          title: { type: "string" },
          intro: { type: "string" },
          thanks: { type: "string" },
          fields: { type: "array", items: { type: "object" }, description: "La lista COMPLETA de campos (mismo formato que form_create)" },
          locale: { type: "string", enum: ["es", "en"], description: "Idioma del formulario" },
          status: { type: "string", enum: ["open", "closed"] },
        },
        required: ["formId"],
      },
      handler: async (_sub, args) => {
        const { updateForm } = await import("../forms/publish.server");
        const patch: Record<string, unknown> = {};
        for (const k of ["title", "intro", "thanks", "locale", "status"]) if (args[k] !== undefined) patch[k] = args[k];
        if (args.fields !== undefined) patch.fields = args.fields;
        const r = await updateForm(String(args.formId ?? ""), patch as never);
        if (!r.ok) return r;
        return { ok: true, formId: r.form.id, url: r.url, status: r.form.status, fields: r.form.fields.length };
      },
    },
    {
      name: "form_list",
      description: "Lista los formularios de intake de este workspace con su liga, su estado y cuántas respuestas han recibido.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const { listForms, formUrl } = await import("../forms/publish.server");
        const list = await listForms();
        return {
          ok: true,
          forms: list.map((f) => ({
            formId: f.id,
            title: f.title,
            url: formUrl(f),
            status: f.status,
            submissions: f.submissionCount,
            lastSubmittedAt: f.lastSubmittedAt,
            thisConversation: dest?.channelId ? f.channelId === dest.channelId : undefined,
          })),
        };
      },
    },
    {
      name: "form_submissions",
      description:
        "Lee las respuestas de un formulario (id de form_list). Úsalo para contestar '¿qué llegó?', " +
        "resumir lo recibido o cruzarlo con un documento. Devuelve los datos por campo.",
      inputSchema: {
        type: "object",
        properties: {
          formId: { type: "string" },
          limit: { type: "number", description: "Cuántas traer, de la más reciente (default 20, máx 100)" },
          since: { type: "string", description: "Sólo desde esta fecha, YYYY-MM-DD" },
        },
        required: ["formId"],
      },
      handler: async (_sub, args) => {
        const { listSubmissions } = await import("../forms/submissions.server");
        return listSubmissions({
          formId: String(args.formId ?? ""),
          limit: typeof args.limit === "number" ? args.limit : undefined,
          since: typeof args.since === "string" ? args.since : undefined,
        });
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

    // ── Correo saliente ─────────────────────────────────────────────────────────
    // La única tool nativa con efectos IRREVERSIBLES fuera del producto. Su contención
    // (validación de direcciones, tope por hora, bitácora, adjunto no elegible por id)
    // vive entera en `email-send.server.ts`.
    {
      name: "email_send",
      description:
        "Envía un correo. Úsalo cuando te pidan mandar algo por correo — es una capacidad REAL de Ghosty Teams. " +
        "Con `attachDoc` adjunta el documento DE ESTA conversación (docx o pdf); no puedes adjuntar otros archivos ni otros documentos. " +
        "⚠️ Un correo enviado NO se puede deshacer: CONFIRMA con quien te lo pide el destinatario, el asunto y si va el documento, " +
        "y hazlo en un solo mensaje antes de llamar a esta herramienta. Nunca mandes correo por iniciativa propia.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "array", items: { type: "string" }, description: "destinatarios (máx 5). Sólo direcciones que te hayan dictado" },
          subject: { type: "string", description: "asunto" },
          body: { type: "string", description: "cuerpo en texto. Se manda como párrafos: no uses HTML ni markdown, no se interpretan" },
          attachDoc: {
            type: "string",
            enum: ["docx", "pdf", "link"],
            description:
              "qué va del documento de esta conversación: `docx`/`pdf` lo adjunta; `link` manda la liga (mejor si pesa —el tope es 10MB— y así ve siempre la versión viva). " +
              "⚠️ `link` PUBLICA el documento: queda visible para cualquiera que tenga la liga. Avísalo. Omítelo si no va nada del documento.",
          },
        },
        required: ["to", "subject", "body"],
      },
      handler: async (sub, args) => {
        const { enviarCorreo } = await import("./email-send.server");
        return enviarCorreo(sub, args, dest);
      },
    },

    // ── Compartir el documento (acceso real, no una copia) ──────────────────────
    // Distinta de `email_send`: aquí no viaja información, se reparte una LLAVE.
    {
      name: "doc_share",
      description:
        "Da acceso al documento de esta conversación a otras personas por correo, con nivel de lectura, comentario o edición. " +
        "PREFIÉRELA sobre adjuntar un archivo cuando quieran que alguien REVISE o APRUEBE algo: la persona ve siempre la versión viva, " +
        "puede comentar sobre el texto y lo que diga vuelve al documento, en vez de perderse en un adjunto. Funciona con gente de fuera: no necesitan cuenta. " +
        "⚠️ Dar acceso NO se deshace solo y no caduca: CONFIRMA antes con quien te lo pide a quién, con qué nivel y de qué documento, en un solo mensaje.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "array", items: { type: "string" }, description: "correos (máx 5). Sólo direcciones que te hayan dictado" },
          role: {
            type: "string",
            enum: ["view", "comment", "edit"],
            description: "`view` sólo lee · `comment` lee y comenta (lo normal para una revisión) · `edit` puede cambiar el texto. Default: comment",
          },
          message: { type: "string", description: "qué esperas de esa persona, en las palabras del usuario ('revisa las cláusulas de plazo antes del viernes')" },
        },
        required: ["to"],
      },
      handler: async (sub, args) => {
        const { compartirDoc } = await import("./doc-share.server");
        return compartirDoc(sub, args, dest);
      },
    },

    // ── Comentarios del documento de esta conversación ──────────────────────────
    // Los hilos se abren desde el editor (el ancla es una marca sobre el texto, y eso
    // pide un editor montado). Ghosty los LEE, responde y cierra: que la gente comente el
    // documento y el agente no pudiera ni enterarse era dejarlo fuera de la conversación
    // que ocurre sobre su propio trabajo.
    {
      name: "doc_comments",
      description:
        "Lee los comentarios del documento de esta conversación: quién comentó qué, y si el hilo sigue abierto. " +
        "Úsalo cuando te pidan atender, revisar o resumir los comentarios de un documento.",
      inputSchema: {
        type: "object",
        properties: {
          only_open: { type: "boolean", description: "true = sólo los hilos sin resolver" },
        },
      },
      handler: async (sub) => {
        const documentId = await docDelTurno(dest);
        if (!documentId) return { ok: false, error: "no hay un documento en esta conversación" };
        try {
          const { listarHilos } = await import("../doc-threads.server");
          const hilos = await listarHilos(documentId, sub);
          return { ok: true, threads: hilos };
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      },
    },
    {
      name: "doc_comment_reply",
      description:
        "Responde a un hilo de comentarios del documento de esta conversación. " +
        "El `thread_id` sale de doc_comments. Si además hay que cambiar el documento, edítalo aparte: " +
        "responder el hilo NO modifica el texto.",
      inputSchema: {
        type: "object",
        properties: {
          thread_id: { type: "string", description: "Id del hilo (de doc_comments)" },
          text: { type: "string", description: "Tu respuesta, en el idioma del hilo" },
          resolve: { type: "boolean", description: "true para además marcar el hilo como resuelto" },
        },
        required: ["thread_id", "text"],
      },
      handler: async (sub, args) => {
        const documentId = await docDelTurno(dest);
        if (!documentId) return { ok: false, error: "no hay un documento en esta conversación" };
        const threadId = String(args.thread_id ?? "").trim();
        const text = String(args.text ?? "").trim();
        if (!threadId || !text) return { ok: false, error: "faltan thread_id o text" };
        try {
          const t = await import("../doc-threads.server");
          await t.responderHilo(documentId, sub, threadId, text);
          if (args.resolve === true) await t.resolverHilo(documentId, sub, threadId, true);
          return { ok: true, resolved: args.resolve === true };
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      },
    },
    {
      name: "doc_comment_resolve",
      description:
        "Marca un hilo de comentarios como resuelto (o lo reabre con `reopen: true`). " +
        "Resuelve sólo cuando el comentario YA quedó atendido.",
      inputSchema: {
        type: "object",
        properties: {
          thread_id: { type: "string", description: "Id del hilo (de doc_comments)" },
          reopen: { type: "boolean", description: "true para reabrirlo en vez de resolverlo" },
        },
        required: ["thread_id"],
      },
      handler: async (sub, args) => {
        const documentId = await docDelTurno(dest);
        if (!documentId) return { ok: false, error: "no hay un documento en esta conversación" };
        const threadId = String(args.thread_id ?? "").trim();
        if (!threadId) return { ok: false, error: "falta thread_id" };
        try {
          const { resolverHilo } = await import("../doc-threads.server");
          await resolverHilo(documentId, sub, threadId, args.reopen !== true);
          return { ok: true, resolved: args.reopen !== true };
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      },
    },
    // ── Historial de la conversación ──────────────────────────────────────────
    // El agente NO tiene el historial entero. Tiene su sesión (que se pierde con /clear o
    // al reciclarse la caja) y un catch-up corto inyectado en el turno. Sin estas dos
    // tools no puede mirar hacia atrás y, peor, contesta que no existe lo que no alcanza
    // a ver.
    //
    // Es la capa "recall" del patrón que ya converge en la comunidad (Letta
    // `conversation_search`, Slack `conversations.history` + `search.messages`): el
    // contexto lleva lo inmediato y lo viejo se PIDE.
    //
    // El scope va FIRMADO en el token, como todo lo demás aquí: se lee la conversación
    // donde te invocaron y ninguna otra. Por eso no hay parámetro de canal.
    {
      name: "chat_search",
      description:
        "Busca por palabras en el historial de ESTA conversación (todo lo que se dijo aquí, " +
        "también antes de que tú llegaras). Úsalo ANTES de decir que algo no existe o que no lo " +
        "recuerdas: tu contexto sólo trae los mensajes recientes. Cada resultado trae su `id`; " +
        "con ese id puedes leer lo que había alrededor usando chat_history({before: id}).",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Palabras a buscar, tal cual aparecerían escritas" },
          limit: { type: "number", description: "Máximo de resultados (tope 20, default 20)" },
        },
        required: ["query"],
      },
      handler: async (_sub, args) => {
        const scope = scopeDelTurno(dest);
        if (!scope) return { ok: false, error: "no hay conversación en este turno" };
        const q = String(args.query ?? "").trim();
        if (!q) return { ok: false, error: "falta query" };
        const db = await import("../../db.server");
        const msgs = await db.searchInScope(scope, q, Number(args.limit) || 20);
        return { ok: true, query: q, count: msgs.length, messages: msgs.map(paraElModelo) };
      },
    },
    {
      name: "chat_history",
      description:
        "Lee hacia atrás el historial de ESTA conversación, en orden cronológico. Sin `before` " +
        "devuelve lo más reciente. Para seguir subiendo, vuelve a llamar con `before` = el " +
        "`oldestId` de la respuesta anterior. Úsalo cuando te pidan algo de 'antes' o necesites " +
        "el hilo de una decisión; si sabes qué palabras buscar, chat_search es más directo.",
      inputSchema: {
        type: "object",
        properties: {
          before: { type: "number", description: "Id de mensaje: devuelve los ANTERIORES a ése (el `oldestId` de la llamada previa)" },
          limit: { type: "number", description: "Cuántos mensajes (tope 50, default 25)" },
        },
      },
      handler: async (_sub, args) => {
        const scope = scopeDelTurno(dest);
        if (!scope) return { ok: false, error: "no hay conversación en este turno" };
        const db = await import("../../db.server");
        const pedidos = Math.max(1, Math.min(Number(args.limit) || 25, 50));
        const msgs = await db.historyBefore(scope, Number(args.before) || null, pedidos);
        return {
          ok: true,
          count: msgs.length,
          messages: msgs.map(paraElModelo),
          // El cursor de la siguiente página. `hasMore` es una pista, no una promesa: si
          // vino la página llena, lo normal es que haya más.
          oldestId: msgs.length ? msgs[0].id : null,
          hasMore: msgs.length === pedidos,
        };
      },
    },
    // ── Papelera de documentos ────────────────────────────────────────────────
    //
    // ⚠️ Hay `doc_archived_list` y `doc_restore`, pero NO `doc_archive`, y es deliberado:
    // archivar es destructivo a plazo (30 días y se borra). El agente no debería poder
    // tirar un expediente por interpretar de más una frase como "ya no necesito esto".
    // Listar y restaurar son reversibles; archivar lo pide una persona, desde el panel.
    {
      name: "doc_archived_list",
      description:
        "Lista los documentos que están en la PAPELERA de este espacio, con los días que le quedan a cada uno " +
        "antes de borrarse para siempre. Úsalo cuando pregunten por un documento que 'ya no aparece', que " +
        "'se borró' o que quieren recuperar. Devuelve el `documentId` que necesita `doc_restore`.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const { listArchivedDocumentsFn } = await import("../documents");
        const docs = await listArchivedDocumentsFn();
        if (!docs.length) return { ok: true, documentos: [], nota: "la papelera está vacía" };
        return {
          ok: true,
          documentos: docs.map((d) => ({
            documentId: d.documentId,
            titulo: d.title,
            room: d.roomName,
            diasRestantes: d.diasRestantes,
          })),
        };
      },
    },
    {
      name: "doc_restore",
      description:
        "Saca un documento de la papelera y lo devuelve al espacio, con el acceso que tenía antes. " +
        "El `documentId` sale de `doc_archived_list`. Sólo funciona si aún no se ha borrado definitivamente.",
      inputSchema: {
        type: "object",
        properties: { documentId: { type: "string", description: "El documentId que devolvió doc_archived_list" } },
        required: ["documentId"],
      },
      handler: async (_sub, args) => {
        const documentId = typeof args?.documentId === "string" ? args.documentId : "";
        if (!documentId) return { ok: false, error: "falta documentId" };
        const { restoreDocumentFn } = await import("../documents");
        // El error de autorización se devuelve TAL CUAL en vez de tragárselo: si el agente
        // no puede restaurarlo porque no es suyo, la persona necesita saber eso y no un
        // "no pude" genérico que la deja adivinando.
        try {
          await restoreDocumentFn({ data: { documentId } });
          return { ok: true, mensaje: "documento restaurado; ya vuelve a aparecer en el espacio" };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
  ];
}

/**
 * El scope de lectura del turno, sacado del destino FIRMADO. Un turno dentro de un hilo se
 * queda en el hilo: es la conversación donde te invocaron.
 */
function scopeDelTurno(
  dest: ToolDest | null
): { dmId: number } | { channelId: number; parentId?: number | null } | null {
  if (!dest) return null;
  if (dest.dmId) return { dmId: dest.dmId };
  if (dest.channelId) return { channelId: dest.channelId, parentId: dest.parentId ?? null };
  return null;
}

/**
 * Un mensaje como lo ve el modelo. Se recorta el cuerpo: 50 mensajes completos pueden ser
 * un documento entero pegado, y lo que se busca aquí es el hilo de la conversación.
 *
 * Incluye los mensajes del PROPIO agente (`@handle`). Es la lección documentada de Slack:
 * su `search.messages` no devuelve mensajes de bot, así que el agente no encuentra lo que
 * él mismo escribió — justo lo que se le suele preguntar.
 */
function paraElModelo(m: {
  id: number;
  sender: string;
  agent_handle: string | null;
  body: string;
  created_at: number;
}) {
  const body = (m.body || "").trim();
  return {
    id: m.id,
    who: m.agent_handle ? `@${m.agent_handle}` : m.sender || "usuario",
    at: new Date(m.created_at).toISOString(),
    text: body.length > 800 ? body.slice(0, 800) + "…" : body,
  };
}

/**
 * El documento sobre el que actúan las tools de comentarios. NO viene en los argumentos,
 * igual que el destino de un recordatorio: el agente actúa sobre el artefacto de ESTA
 * conversación, y así no puede alcanzar el documento de otra pidiendo un id que se
 * inventó.
 */
async function docDelTurno(dest: ToolDest | null): Promise<string | null> {
  if (!dest) return null;
  const db = await import("../../db.server");
  if (dest.dmId) return db.getDmArtifact(dest.dmId);
  if (dest.channelId) return db.getThreadArtifact(dest.channelId, null);
  return null;
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
