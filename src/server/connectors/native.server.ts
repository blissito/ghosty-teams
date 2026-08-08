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
import { BRAND_MOODS } from "#/lib/brand-tokens";
import { BRAND_FONTS } from "#/lib/brand-fonts";
import type { ConnectorTool } from "./impl";
// El destino se define donde se FIRMA (tool-token), que es lo que lo hace confiable.
export type { ToolDest } from "./tool-token.server";
import type { ToolDest } from "./tool-token.server";

const REPEATS = ["daily", "weekly", "monthly"] as const;

// Los ids del catálogo, para el `description` de las tools de marca. El modelo tiene que
// ver la lista EN el schema: si tuviera que adivinar el nombre de la fuente, mandaría
// "Playfair Display" y el saneador lo tiraría sin decir nada.
const FONT_IDS = BRAND_FONTS.map((f) => `${f.id} (${f.family})`).join(", ");

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
          fromFormId: {
            type: "string",
            description:
              "Parte de un formulario que YA existe (saca el id con form_list): hereda campos, intro, " +
              "gracias e idioma, y lo que mandes aquí los pisa. Es un formulario NUEVO con liga nueva, " +
              "no la misma. Úsalo para repetir en otro cliente algo que ya funcionó, o para adaptar una " +
              "plantilla en vez de dictar 40 campos otra vez",
          },
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
                  enum: ["text", "email", "tel", "textarea", "select", "date", "number", "checkbox", "radio", "file", "matrix", "group"],
                  description:
                    "checkbox=consentimiento; radio=opción única (options, o Sí/No); select=lista; file=archivo; " +
                    "matrix=rejilla (columnas en options, filas en rows, una respuesta por fila); " +
                    "group=LISTA REPETIBLE: N elementos con los mismos subcampos (herederos, dependientes, " +
                    "inmuebles, hijos). Sus subcampos van en `fields`, y `itemLabel` es cómo se llama UNO " +
                    "('Heredero'). Úsalo siempre que la cantidad la decida quien responde, en vez de inventar " +
                    "heredero_1, heredero_2, heredero_3",
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
                fields: {
                  type: "array",
                  items: { type: "object" },
                  description:
                    "Sólo group: los subcampos que se repiten, mismo formato que un campo. NO pueden ser " +
                    "group, file ni matrix, ni llevar section. Su showIf sólo puede apuntar a otro subcampo suyo",
                },
                itemLabel: { type: "string", description: "Sólo group: cómo se llama UN elemento ('Heredero')" },
                min: { type: "number", description: "Sólo group: mínimo de elementos (con required)" },
                max: { type: "number", description: "Sólo group: máximo de elementos (default 10, tope 20)" },
              },
              required: ["name", "type", "label"],
            },
          },
        },
        // `fields` no va en required: clonando se heredan del original. Si no hay ni uno
        // ni otro, `createForm` lo dice con su propio mensaje.
        required: ["title"],
      },
      handler: async (sub, args) => {
        if (!dest?.channelId) return { ok: false, error: "los formularios sólo se pueden crear dentro de un canal" };
        const { createForm } = await import("../forms/publish.server");
        const r = await createForm({
          channelId: dest.channelId,
          topic: dest.topic || "general",
          title: String(args.title ?? ""),
          fields: args.fields,
          fromFormId: typeof args.fromFormId === "string" ? args.fromFormId : undefined,
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
          fichaMode: {
            type: "string",
            enum: ["off", "auto"],
            description:
              "'auto' publica la ficha de CADA respuesta al llegar; 'off' (default) sólo cuando la " +
              "pidan con form_ficha. Prende 'auto' sólo si te lo piden: con volumen, un documento " +
              "por respuesta llena el hilo y la hoja ya trae todo junto.",
          },
          draftTtlDays: {
            type: "number",
            description:
              "Días que vive un borrador de 'guardar y continuar'. 0 = apagado (default). Ofrécelo " +
              "cuando el formulario sea largo (30+ campos) o pida documentos que hay que ir a buscar. " +
              "⚠️ Adviértelo: el enlace de reanudación deja ver lo que esa persona lleva escrito a " +
              "cualquiera que lo tenga, así que en un intake sensible puede no convenir.",
          },
          status: { type: "string", enum: ["open", "closed"] },
        },
        required: ["formId"],
      },
      handler: async (_sub, args) => {
        const { updateForm } = await import("../forms/publish.server");
        const patch: Record<string, unknown> = {};
        for (const k of ["title", "intro", "thanks", "locale", "fichaMode", "draftTtlDays", "status"]) if (args[k] !== undefined) patch[k] = args[k];
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
    {
      name: "form_ficha",
      description:
        "Publica la FICHA de UNA respuesta: un documento con lo que contestó esa persona, colgado " +
        "del hilo del formulario. Úsalo cuando pidan 'el expediente de Fulano', 'pásame lo que " +
        "llenó', 'necesito su ficha en documento' o cuando vayas a trabajar sobre una respuesta " +
        "concreta. El `submissionId` es el `id` que devuelve form_submissions. Es idempotente: si " +
        "esa respuesta ya tiene ficha, te devuelve la que hay en vez de crear otra. Para las que " +
        "llegan de aquí en adelante, form_update con fichaMode:'auto'.",
      inputSchema: {
        type: "object",
        properties: {
          formId: { type: "string" },
          submissionId: { type: "number", description: "El `id` de la respuesta (de form_submissions)" },
        },
        required: ["formId", "submissionId"],
      },
      handler: async (_sub, args) => {
        const { ensureFicha } = await import("../forms/ficha.server");
        return ensureFicha({
          formId: String(args.formId ?? ""),
          submissionId: Math.floor(Number(args.submissionId ?? 0)),
        });
      },
    },
    {
      name: "form_webhook",
      description:
        "Propone mandar cada respuesta de un formulario a otro sistema (su CRM, su ERP, un Zapier, " +
        "un endpoint propio). ⚠️ NO lo activa: queda apagado y el dueño tiene que prenderlo desde " +
        "/forms, donde además está el secreto para verificar la firma. Dilo así al contestar — que " +
        "le falta un paso y dónde. Sin `url`, lista los destinos que ya tiene ese formulario.",
      inputSchema: {
        type: "object",
        properties: {
          formId: { type: "string" },
          url: { type: "string", description: "https:// obligatorio. Sin esto, sólo lista." },
          includeFiles: {
            type: "boolean",
            description:
              "Mandar también los archivos adjuntos. Default false; pregúntalo, porque mandarle a " +
              "un tercero el acta de nacimiento de alguien es una decisión aparte.",
          },
        },
        required: ["formId"],
      },
      handler: async (_sub, args) => {
        const { listHooks, proposeHook } = await import("../forms/webhooks.server");
        const formId = String(args.formId ?? "");
        if (!args.url) return { ok: true, hooks: await listHooks(formId) };
        const r = await proposeHook({
          formId,
          url: String(args.url),
          includeFiles: args.includeFiles === true,
        });
        if (!r.ok) return r;
        return {
          ok: true,
          hook: r.hook,
          pendiente: "queda APAGADO: el dueño lo activa en /forms, y ahí está el secreto de la firma",
        };
      },
    },
    // ── Memoria ───────────────────────────────────────────────────────────────
    // UNA memoria con dos alcances (misma tabla, mismas tools — decidido 2026-08-08 para
    // no confundir al agente con dos sistemas):
    //  · room/DM — convenciones de ESA conversación, por agente. Se inyectan COMPLETAS
    //    en cada turno (memoryHint), por eso no necesitan lectura.
    //  · workspace — hechos de la empresa, compartidos entre rooms y agentes. Al turno
    //    sólo viaja el ÍNDICE (título + hook); `memory_read` trae la nota completa.
    {
      name: "memory_write",
      description:
        "Guarda algo en la memoria, para que siga vigente en turnos futuros. Dos alcances: " +
        "`room` (default) = convención de ESTA conversación (formato de los documentos, cómo se " +
        "llaman las partes, tratamientos); `workspace` = hecho de la EMPRESA que vale en cualquier " +
        "conversación (datos de un cliente, un proceso, un manual de marca destilado, cómo firma el " +
        "despacho). Úsalo cuando te digan 'de ahora en adelante', 'siempre', 'recuérdalo', 'anótalo' " +
        "o 'guárdalo en la memoria del workspace'. NO guardes el contenido de los documentos (para " +
        "eso están los artefactos), ni datos sensibles que nadie pidió guardar, ni el estado de una " +
        "tarea en curso. Si ya existe una nota parecida, actualízala con `replaces` en vez de añadir " +
        "otra: dos notas que se contradicen es peor que ninguna.",
      inputSchema: {
        type: "object",
        properties: {
          note: { type: "string", description: "el contenido, corto y accionable" },
          scope: {
            type: "string",
            enum: ["room", "workspace"],
            description: "room = esta conversación (default) · workspace = toda la empresa",
          },
          title: {
            type: "string",
            description: "sólo workspace: título corto para el índice (ej. 'Cliente ACME — facturación')",
          },
          replaces: {
            type: "number",
            description: "id de la nota que sustituye (el que ves en la memoria del turno; para workspace usa el número del id ws:N)",
          },
        },
        required: ["note"],
      },
      handler: async (sub, args) => {
        const db = await import("../../db.server");
        const note = String(args.note ?? "").trim().replace(/\s+/g, " ");
        if (!note) return { ok: false, error: "la nota viene vacía" };

        if (args.scope === "workspace") {
          if (note.length > db.WS_MEMORY_MAX_CHARS)
            return { ok: false, error: `demasiado larga (máx ${db.WS_MEMORY_MAX_CHARS} caracteres); destílala — guarda lo operativo, no el documento` };
          if (args.replaces != null) {
            const id = Number(args.replaces);
            const ok = await db.updateWorkspaceMemory(id, {
              note,
              ...(args.title ? { title: String(args.title).slice(0, db.WS_MEMORY_TITLE_MAX) } : {}),
            });
            return ok ? { ok: true, id: `ws:${id}` } : { ok: false, error: "esa nota no existe en la memoria del workspace" };
          }
          const title = String(args.title ?? "").trim().slice(0, db.WS_MEMORY_TITLE_MAX);
          if (!title) return { ok: false, error: "una nota de workspace necesita `title` (es lo que sale en el índice)" };
          const existing = await db.listWorkspaceMemory();
          if (existing.length >= db.WS_MEMORY_MAX_NOTES)
            return {
              ok: false,
              error: `la memoria del workspace está llena (${db.WS_MEMORY_MAX_NOTES} notas). Borra o sustituye alguna (memory_forget / replaces)`,
            };
          // Autoría: el agente escribe, pero quien lo pidió queda como origen junto al
          // handle — en la UI de /memory se ve quién y desde dónde nació cada hecho.
          const sourceRef = dest?.channelId != null ? `ch:${dest.channelId}` : dest?.dmId != null ? `dm:${dest.dmId}` : null;
          const author = dest?.handle ? `@${dest.handle}` : sub;
          const id = await db.addWorkspaceMemory(title, note, author, sourceRef);
          return { ok: true, id: `ws:${id}` };
        }

        if (!dest) return { ok: false, error: "no puedo guardar memoria de room fuera de una conversación" };
        const scope = db.memoryScopeKey(dest);
        const handle = dest.handle;
        if (!scope || !handle) return { ok: false, error: "no pude identificar la conversación" };
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
      name: "memory_read",
      description:
        "Lee una nota completa de la memoria del workspace por su id del índice (`ws:N`). El índice " +
        "del turno sólo trae título y arranque; usa esto ANTES de aplicar un hecho del workspace " +
        "(formato, datos de un cliente, reglas de marca) para trabajar con la nota entera.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "id del índice, ej. 'ws:12' (o el número solo)" } },
        required: ["id"],
      },
      handler: async (_sub, args) => {
        const db = await import("../../db.server");
        const id = Number(String(args.id ?? "").replace(/^ws:/, ""));
        if (!Number.isFinite(id) || id <= 0) return { ok: false, error: "id inválido; usa el ws:N del índice" };
        const note = await db.getWorkspaceMemory(id);
        return note
          ? { ok: true, id: `ws:${note.id}`, title: note.title, note: note.note, author: note.createdBy }
          : { ok: false, error: "esa nota no existe (¿la borraron desde /memory?)" };
      },
    },
    {
      name: "memory_forget",
      description:
        "Borra una nota de la memoria por su id: un número = nota de esta conversación; `ws:N` = " +
        "nota del workspace. Úsalo cuando algo deje de aplicar o te digan que lo olvides.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "id de la nota (número o 'ws:N')" } },
        required: ["id"],
      },
      handler: async (_sub, args) => {
        const db = await import("../../db.server");
        const raw = String(args.id ?? "").trim();
        if (/^ws:\d+$/.test(raw)) {
          const ok = await db.deleteWorkspaceMemory(Number(raw.slice(3)));
          return ok ? { ok: true } : { ok: false, error: "esa nota no existe en la memoria del workspace" };
        }
        if (!dest) return { ok: false, error: "no puedo borrar memoria de room fuera de una conversación" };
        const scope = db.memoryScopeKey(dest);
        const handle = dest.handle;
        if (!scope || !handle) return { ok: false, error: "no pude identificar la conversación" };
        const ok = await db.deleteAgentMemory(Number(raw), scope, handle);
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
    // ── Marca del workspace ───────────────────────────────────────────────────
    // El agente puede armar la marca en conversación ("saca el brandkit de mi página"),
    // que es la mitad del valor de la feature: nadie quiere abrir Ajustes y teclear
    // cuatro hex. Lo que NO puede es activarla sin que se lo pidan — cambiar la marca
    // repinta lo que se publique después, y eso lo decide una persona.
    {
      name: "brand_list",
      description:
        "Lista las marcas (brand kits) del espacio: colores, fuentes y logo de cada una, y cuál está " +
        "activa. La activa es la que se usa al generar documentos, formularios y ligas compartidas.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const { listBrandKits } = await import("../brand.server");
        const kits = await listBrandKits();
        return {
          ok: true,
          kits: kits.map((k) => ({
            id: k.id,
            nombre: k.name,
            activa: k.isActive,
            colores: k.colors,
            fuentes: k.fonts,
            logo: k.logoUrl,
          })),
        };
      },
    },
    {
      name: "brand_extract",
      description:
        "Saca la marca (colores, fuentes y logo) de una página web y la guarda como un brand kit nuevo. " +
        "Úsalo cuando te den la URL de un sitio y pidan usar esa identidad. Queda GUARDADA pero NO activa: " +
        "dile a la persona qué encontraste y pregúntale si la activa. Revisa el resultado antes de " +
        "presumirlo — si no se encontró logo, dilo.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "La página de la que sacar la marca" },
          name: { type: "string", description: "Nombre para el kit; si lo omites se toma el del sitio" },
        },
        required: ["url"],
      },
      handler: async (sub, args) => {
        const raw = String(args.url ?? "").trim();
        if (!raw) return { ok: false, error: "falta la url" };
        try {
          const { extractFromUrl } = await import("../brand-extract.server");
          const { createBrandKit } = await import("../brand.server");
          const out = await extractFromUrl(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
          const kit = await createBrandKit(
            {
              name: String(args.name ?? "").trim() || out.name || "Marca",
              colors: out.colors,
              fonts: out.fonts,
              logoKey: out.logoKey,
            },
            sub
          );
          return {
            ok: true,
            id: kit.id,
            nombre: kit.name,
            colores: kit.colors,
            fuentes: kit.fonts,
            logo: kit.logoUrl,
            activa: kit.isActive,
            // Que el modelo pueda decir la verdad sobre lo que NO salió, en vez de callarlo.
            aviso: out.logoKey ? null : "no encontré el logo en esa página; hay que subirlo a mano",
          };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    {
      name: "brand_activate",
      description:
        "Activa una marca ya guardada (saca el id con brand_list). A partir de ese momento los " +
        "documentos, formularios y ligas que se publiquen salen con ella. PIDE CONFIRMACIÓN antes: " +
        "cambia la identidad visual de todo el espacio.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Id del kit" } },
        required: ["id"],
      },
      handler: async (_sub, args) => {
        const id = String(args.id ?? "").trim();
        if (!id) return { ok: false, error: "falta el id" };
        const { getBrandKit, activateBrandKit } = await import("../brand.server");
        if (!(await getBrandKit(id))) return { ok: false, error: "no existe esa marca" };
        await activateBrandKit(id);
        return { ok: true };
      },
    },
    {
      name: "brand_update",
      description:
        "Cambia una marca existente: nombre, colores, fuentes o tono (saca el id con brand_list). " +
        "Manda SÓLO lo que cambia; lo demás se queda igual. Úsalo cuando te pidan ajustar la " +
        "identidad ('ponle el azul de la papelería', 'hazla más sobria', 'que los títulos vayan en " +
        "serif'). Si la marca está activa, el cambio se ve en lo que se publique a partir de ahí; " +
        "lo ya publicado conserva la marca con la que nació.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Id del kit" },
          name: { type: "string", description: "Nombre nuevo" },
          primary: { type: "string", description: "Color principal en hex (#rrggbb)" },
          secondary: { type: "string", description: "Color secundario en hex" },
          accent: { type: "string", description: "Color de acento en hex" },
          surface: { type: "string", description: "Color de fondo/papel en hex" },
          headingFont: {
            type: "string",
            description: `Fuente de títulos. Uno de: ${FONT_IDS}. Cadena vacía = la del sistema`,
          },
          bodyFont: {
            type: "string",
            description: `Fuente de texto. Uno de: ${FONT_IDS}. Cadena vacía = la del sistema`,
          },
          mood: {
            type: "string",
            enum: [...BRAND_MOODS],
            description:
              "Carácter visual. Mueve de verdad el redondeo, el grosor de línea, la sombra y la " +
              "tipografía: minimal y elegant son cuadrados y sobrios, playful y vibrant redondos y " +
              "teñidos, bold lleva línea gruesa y contraste alto",
          },
        },
        required: ["id"],
      },
      handler: async (_sub, args) => {
        const id = String(args.id ?? "").trim();
        if (!id) return { ok: false, error: "falta el id" };
        const { getBrandKit, updateBrandKit } = await import("../brand.server");
        const actual = await getBrandKit(id);
        if (!actual) return { ok: false, error: "no existe esa marca (revisa el id con brand_list)" };

        // ⚠️ Se valida ANTES de escribir y se devuelve el error con la lista de opciones.
        // El saneador de fuentes descarta un id desconocido en silencio, así que sin esto el
        // agente diría "ya le puse Playfair" y no habría pasado nada — el mismo fallo mudo
        // que tuvo esta feature entera.
        const { BRAND_FONTS } = await import("#/lib/brand-fonts");
        for (const campo of ["headingFont", "bodyFont"] as const) {
          const v = args[campo];
          if (v === undefined || v === "") continue;
          if (!BRAND_FONTS.some((f) => f.id === String(v))) {
            return { ok: false, error: `no existe la fuente "${v}". Opciones: ${FONT_IDS}` };
          }
        }

        const patch: Parameters<typeof updateBrandKit>[1] = {};
        if (args.name !== undefined) patch.name = String(args.name);
        if (args.mood !== undefined) patch.mood = String(args.mood);

        // Los colores se MEZCLAN con los actuales: cambiar sólo el principal no puede
        // borrar los otros tres.
        const cambiaColor = ["primary", "secondary", "accent", "surface"].some((k) => args[k] !== undefined);
        if (cambiaColor) {
          patch.colors = {
            ...actual.colors,
            ...(args.primary !== undefined ? { primary: String(args.primary) } : {}),
            ...(args.secondary !== undefined ? { secondary: String(args.secondary) } : {}),
            ...(args.accent !== undefined ? { accent: String(args.accent) } : {}),
            ...(args.surface !== undefined ? { surface: String(args.surface) } : {}),
          };
        }
        if (args.headingFont !== undefined || args.bodyFont !== undefined) {
          patch.fonts = {
            ...(actual.fonts ?? {}),
            ...(args.headingFont !== undefined ? { heading: String(args.headingFont) || undefined } : {}),
            ...(args.bodyFont !== undefined ? { body: String(args.bodyFont) || undefined } : {}),
          };
        }

        try {
          const out = await updateBrandKit(id, patch);
          // Se devuelve el estado REAL tras guardar, no un "listo": si el saneador tiró
          // algo, el agente lo ve y puede decirlo.
          return {
            ok: true,
            nombre: out?.name,
            colores: out?.colors,
            fuentes: out?.fonts,
            tono: out?.mood,
            activa: out?.isActive,
          };
        } catch (e) {
          // normalizeColors lanza ante un hex inválido, y ese mensaje es el útil.
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    {
      name: "brand_set_logo",
      description:
        "Pone el logo de una marca a partir de la URL de una imagen (png, jpg, webp o svg). " +
        "Úsalo cuando te pasen la liga de un logo o cuando lo encuentres en la web del cliente. " +
        "Lo descargamos y lo servimos nosotros: la liga original puede caducar.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Id del kit" },
          url: { type: "string", description: "URL pública de la imagen" },
        },
        required: ["id", "url"],
      },
      handler: async (_sub, args) => {
        const id = String(args.id ?? "").trim();
        const url = String(args.url ?? "").trim();
        if (!id || !url) return { ok: false, error: "faltan id o url" };
        // Mismo guard SSRF que la extracción por URL: esto hace fetch desde una caja que
        // ve el bridge del host y la red interna de la flota.
        let u: URL;
        try {
          u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
        } catch {
          return { ok: false, error: "url inválida" };
        }
        if (
          (u.protocol !== "https:" && u.protocol !== "http:") ||
          /^(localhost|\[?::1\]?|.*\.local)$/i.test(u.hostname) ||
          /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname)
        ) {
          return { ok: false, error: "esa dirección no es pública" };
        }
        const { getBrandKit, updateBrandKit, putLogo } = await import("../brand.server");
        if (!(await getBrandKit(id))) return { ok: false, error: "no existe esa marca" };
        try {
          const res = await fetch(u.toString(), { signal: AbortSignal.timeout(15_000) });
          if (!res.ok) return { ok: false, error: `no pude bajar la imagen (${res.status})` };
          const tipo = (res.headers.get("content-type") || "").split(";")[0].trim();
          const key = await putLogo(await res.blob(), u.pathname.split("/").pop() || "logo", tipo);
          const out = await updateBrandKit(id, { logoKey: key });
          return { ok: true, logo: out?.logoUrl };
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
