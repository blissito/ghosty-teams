import { createFileRoute } from "@tanstack/react-router";

// ── DEV DRIVER (solo no-producción) ──────────────────────────────────────────
// Permite a un operador (Claude, por el usuario) manejar un room desde fuera del
// navegador para PRUEBAS del vertical legal: fija la persona legal en @ghosty y
// manda turnos que corren el MISMO askAgent del composer → el room se actualiza en
// vivo por el bus (el usuario solo mira). NO existe en producción.
//
//   POST /api/dev/drive  { action: "set-persona" }                → hornea persona legal en @ghosty
//   POST /api/dev/drive  { action: "reset-persona" }              → borra la persona (vuelve al default)
//   POST /api/dev/drive  { action: "say", slug, text, sender? }   → manda un turno como el usuario
//
// Guardado a NODE_ENV !== production. En dev es localhost, aislado.

const LEGAL_PERSONA = `Eres el asistente legal de un despacho mexicano. Trato de USTED siempre, cortés, profesional, claro para no-abogados (si usas un término técnico —rescisión, prescripción, caducidad— defínelo en una línea). Cero modismos, cero humor. Confidencialidad total.

REGLAS DE EXACTITUD (CRÍTICO): NUNCA inventes números de artículo, tesis, jurisprudencias, registros ni citas. Si no estás 100% seguro de un fundamento, VERIFÍCALO con WebSearch en los portales oficiales del Semanario Judicial de la Federación (sjf2.scjn.gob.mx/detalle/tesis/[registro] y sjfsemanal.scjn.gob.mx) ANTES de citarlo. Si una tesis no la puedes confirmar tras 2-3 intentos, NO la inventes: hedgea ("cuya aplicabilidad se reserva impugnar") y avísale al cliente que la confirme directo en el SJF. Los agravios se sostienen en los artículos del código aunque una tesis quede pendiente. No sustituyes a un abogado titulado: recuérdalo con naturalidad para asuntos delicados.

VARIOS DOCUMENTOS (evita saturar el contexto): cuando suban un expediente (demanda, contestación, pericial, confesional, sentencia, carpeta), extrae cada doc UNA vez a analysis/NN_nombre.txt (office-reader/pdf-reader por Bash), léelo UNA sola vez tomando notas en analysis/notas.md con # de línea, y DESPUÉS NO releas el .txt completo: para citas usa grep -n + sed -n de esa franja. Redacta desde notas.md. Read tiene límite ~25k tokens: usa offset/limit y verifica con wc -l.

ENTREGA EN VIVO (regla absoluta de este canal): TODO escrito de prosa (recurso, demanda, contestación, denuncia, contrato, carta, dictamen, convenio) se entrega como UN bloque que abre con \`\`\`eb-doc y cierra con \`\`\` (Markdown: # título, ## secciones/agravios, **negritas**). Se muestra redactándose EN VIVO en el panel, con versiones y descarga a Word. PROHIBIDO generar .docx con oficio/python-docx/docs-router/structured_doc/upload_file. Para MODIFICAR un escrito ya existente, RE-EMITE el eb-doc COMPLETO con el cambio integrado (nunca un fragmento). Fuera del bloque, solo una frase breve de contexto.

REPORTE DE AVANCE: mientras trabajas (investigando, leyendo, verificando), reporta tu progreso como una LISTA breve con viñetas y un emoji al inicio de cada paso (🔍 buscando, 📖 leyendo el expediente, 📥 descargué el código, ✅ verifiqué la tesis, ✍️ redactando), NUNCA como prosa corrida de varias frases. Un renglón por paso.

ESQUELETO de un recurso de apelación (CDMX): Proemio (al juez de origen, quién apela, contra qué sentencia y expediente) → Antecedentes (hechos numerados) → Agravios (uno por error, cada uno correlacionado con el considerando/resolutivo que ataca + artículos aplicables + tesis verificada si aplica) → Argumentos adicionales → Petitorios + protesta y firma. Para una denuncia/querella penal: proemio ante la Fiscalía + personalidad (poder) + asesores jurídicos + hechos numerados + implicados + delitos con sus artículos del código penal estatal + datos de prueba conforme al Código Nacional de Procedimientos Penales.`;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/dev/drive")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        if (process.env.NODE_ENV === "production") return new Response("not found", { status: 404 });
        const body = (await request.json().catch(() => ({}))) as {
          action?: string;
          slug?: string;
          text?: string;
          sender?: string;
        };
        const db = await import("../db.server");

        if (body.action === "set-persona" || body.action === "reset-persona") {
          const ag = await db.getAgentByHandle("ghosty");
          if (!ag) return json({ error: "no existe @ghosty en este team" }, 404);
          const sp = body.action === "reset-persona" ? null : LEGAL_PERSONA;
          await db.updateAgent(ag.id, { systemPrompt: sp });
          return json({ ok: true, agentId: ag.id, personaLen: sp?.length ?? 0 });
        }

        if (body.action === "say") {
          const slug = body.slug;
          const text = (body.text || "").trim();
          const sender = body.sender || "Bliss";
          if (!slug || !text) return json({ error: "faltan slug/text" }, 400);
          const bus = await import("../server/bus.server");
          const { currentNamespace } = await import("../server/tenant.server");
          const { askAgent } = await import("../server/chat");
          const channel = await db.getChannel(slug);
          if (!channel) return json({ error: "canal no encontrado" }, 404);
          const ns = await currentNamespace();

          // 1) Mensaje del usuario (como si lo hubiera escrito él) + aviso al bus.
          const { id: userMsgId } = await db.createMessage({
            channelId: channel.id,
            parentId: null,
            sender,
            avatar: "",
            body: text,
            agentHandle: "ghosty",
            topic: "general",
          });
          const created = await db.getMessage(userMsgId);
          if (created) bus.publish(bus.ch.room(ns, channel.id), { t: "message:new", msg: created });

          // 2) "pensando…" bajo el mensaje (askAgent lo limpia al primer token).
          await db.postAgent(channel.id, userMsgId, "👾 pensando…", "status", "ghosty", "Ghosty", "general", "");
          bus.publish(bus.ch.room(ns, channel.id), { t: "refresh", channelId: channel.id, parentId: userMsgId });

          // 3) Turno del agente: MISMO camino del composer (streamea al panel eb-doc).
          //    Un top-level abre hilo bajo el mensaje (parent = userMsgId), fleetThread="flow".
          const reply = await askAgent({
            data: { slug, parentId: userMsgId, body: text, sender, handle: "ghosty", fleetThread: "flow" },
          });
          return json({ ok: true, userMsgId, reply });
        }

        return json({ error: "acción desconocida (set-persona | reset-persona | say)" }, 400);
      },
    },
  },
});
