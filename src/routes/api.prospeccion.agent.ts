import { createFileRoute } from "@tanstack/react-router";

// POST /api/prospeccion/agent → un turno de agente sobre UNA lista, en SSE.
//
// No usa `runAgentTurn` a propósito. Ése es el camino del CHAT: crea una cáscara de
// mensaje, la postea en un canal, publica al bus y la deja en el historial del room. Aquí
// no hay room — el drawer es una conversación sobre una lista, y meterla en un canal
// llenaría el chat del equipo con «filtra las que no tienen teléfono».
//
// Se usa `callAgentBackendStream` directo, que es la misma pieza que ya mueve las columnas
// de agente (`write.server.ts`).
//
// ⚠️ El `origin` va EXPLÍCITO. `reqOrigin()` lee las cabeceras del request vivo, y el turno
// corre dentro de un `await` largo: sin él, el minteo del tool-token cae al catch y el
// agente corre SIN HERRAMIENTAS — diría «no tengo acceso a tus listas» con todo conectado.
export const Route = createFileRoute("/api/prospeccion/agent")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const { sessionUser } = await import("../server/chat");
        const me = await sessionUser();
        if (!me) return new Response("unauthorized", { status: 401 });

        const body = (await request.json().catch(() => null)) as {
          listId?: number;
          text?: string;
          handle?: string;
          filter?: string;
        } | null;
        const text = (body?.text ?? "").trim();
        const listId = Number(body?.listId ?? 0);
        if (!text || !listId) return new Response("bad request", { status: 400 });

        const { resolvedAgents, callAgentBackendStream } = await import("../agents.server");
        const agents = await resolvedAgents().catch(() => []);
        const agent = body?.handle ? agents.find((a) => a.handle === body.handle) : agents[0];
        if (!agent) {
          return new Response(
            `data: ${JSON.stringify({ t: "error", v: "No hay ningún agente activo en este workspace." })}\n\n`,
            { status: 200, headers: sseHeaders() }
          );
        }

        const { currentNamespace } = await import("../server/tenant.server");
        const { reqOrigin } = await import("../origin.server");
        const ns = await currentNamespace();
        const origin = await reqOrigin().catch(() => undefined);

        // El contexto de la lista va en el TEXTO del turno, no en el system prompt: el
        // worker firma la sesión con las CLAVES del env, y meter algo que cambia por lista
        // reciclaría la sesión en cada mensaje y tiraría el warm.
        const { listContext } = await import("../server/prospeccion/agent.server");
        const contexto = await listContext(listId, body?.filter);

        const stream = new ReadableStream({
          async start(controller) {
            const enc = new TextEncoder();
            const send = (o: unknown) => {
              try {
                controller.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
              } catch {
                // El cliente colgó. Escribir en un socket cerrado no lanza, así que esto
                // es lo único que lo delata.
              }
            };

            // Lo que contestó, para poder guardarlo al cerrar el turno.
            let respuesta = "";
            const usadas: string[] = [];

            try {
              await callAgentBackendStream(
                agent,
                // Una conversación por LISTA y por persona: el hilo de Ana sobre la lista 7
                // no es el de Luis, y el de la lista 7 no es el de la 8.
                `prosp:drawer:${listId}:${me.sub}`,
                me.name ?? "Alguien",
                `${contexto}\n\n---\n\n${text}`,
                (chunk) => { respuesta += chunk; send({ t: "delta", v: chunk }); },
                [],
                (ev) => {
                  const nombre = (ev as { name?: string } | null)?.name;
                  if (nombre) usadas.push(String(nombre));
                  send({ t: "tool", v: ev });
                },
                null,
                me.sub,
                request.signal,
                // `dest` sin canal: las tools nativas que exigen uno (formularios) se
                // niegan solas, que es lo correcto — desde aquí no se crea un formulario.
                { handle: agent.handle, name: agent.name ?? agent.handle },
                false,
                origin
              );
              send({ t: "done" });
              /*
                Se guarda al CERRAR, no al empezar. Un turno abortado a la mitad no debe
                dejar una respuesta vacía en el historial: al recargar se leería como que el
                agente no contestó, cuando lo que pasó es que se canceló.
              */
              if (respuesta.trim()) {
                const { saveDrawerTurn } = await import("../server/prospeccion/agent.server");
                await saveDrawerTurn({
                  listId,
                  sub: me.sub,
                  user: text,
                  agent: respuesta,
                  tools: usadas,
                }).catch(() => {
                  // Perder el historial no puede tumbar el turno: el trabajo ya se hizo.
                });
              }
            } catch (e) {
              send({ t: "error", v: String(e instanceof Error ? e.message : e).slice(0, 300) });
            } finally {
              try { controller.close(); } catch { /* ya cerrado */ }
            }
          },
        });

        return new Response(stream, { status: 200, headers: sseHeaders(ns) });
      },
    },
  },
});

function sseHeaders(ns?: string): Record<string, string> {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Sin esto, un proxy con buffer se guarda el stream entero y lo suelta al final: se ve
    // como que el agente no contesta y de golpe escupe todo.
    "X-Accel-Buffering": "no",
    ...(ns ? { "X-Ghosty-Ns": ns } : {}),
  };
}
