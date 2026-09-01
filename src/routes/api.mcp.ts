import { createFileRoute } from "@tanstack/react-router";

// ── Teams como servidor MCP (Streamable HTTP) ────────────────────────────────────
//
// Para agentes ACP que NO son nuestros: un GhostyCode o un Gemini CLI en la caja de otra
// persona no tiene `/opt/gs-sdk` ni ninguna `GS_*`, y no hay forma de instalárselo — se
// hornea en la imagen del template. Lo que sí acepta es que el CLIENTE le entregue un
// servidor MCP en `session/new` (`mcpCapabilities.http`), y eso no le cuesta configurar
// nada a nadie.
//
// ⚠️ DE DÓNDE SALE LA AUTORIDAD. El `Bearer` de aquí es un TICKET que sólo dice qué
// conversación es. Quién invoca (`sub`), dónde (`dest`) y hasta dónde (`scope`) se resuelven
// en CADA llamada contra el turno en vuelo (`inflightAuthority`). Sin turno en curso no se
// ejerce nada. Es lo que permite que la URL viva lo que la sesión sin ser una llave.
//
// El mínimo conforme del transporte, y no hace falta más: una sola ruta, POST → JSON
// (`application/json` es una de las dos respuestas que la spec permite; soportar las dos es
// obligación del CLIENTE), 202 sin cuerpo a las notificaciones, 405 al GET (la spec lo dice
// literal: SSE o 405) y validación de `Origin`. Sin SSE, sin `Mcp-Session-Id`, sin OAuth.
const VERSIONES = ["2025-06-18", "2025-03-26", "2024-11-05"];

export const Route = createFileRoute("/api/mcp")({
  server: {
    handlers: {
      // La spec exige POST y GET en la misma ruta, pero permite 405 en el GET para decir
      // "aquí no hay stream". Es lo que hacemos: no tenemos nada que empujar.
      GET: () => new Response("Method Not Allowed", { status: 405 }),
      DELETE: () => new Response("Method Not Allowed", { status: 405 }),
      POST: async ({ request }: { request: Request }) => {
        const rpc = (id: unknown, body: Record<string, unknown>) =>
          new Response(JSON.stringify({ jsonrpc: "2.0", id, ...body }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        const err = (id: unknown, code: number, message: string) => rpc(id, { error: { code, message } });

        // ⚠️ El único MUST de seguridad del transporte. Un agente en su caja no manda
        // `Origin`; el que lo manda es un navegador, y un navegador no tiene nada que hacer
        // aquí — sería una página cualquiera usando las tools del espacio de quien la abra.
        const origin = request.headers.get("origin");
        if (origin) return new Response("Forbidden", { status: 403 });

        let m: { jsonrpc?: string; id?: unknown; method?: string; params?: any };
        try {
          m = await request.json();
        } catch {
          return err(null, -32700, "JSON inválido");
        }
        // Notificación (sin `id`): la spec obliga a 202 SIN CUERPO. Contestar un JSON-RPC
        // aquí es el fallo típico de un servidor MCP escrito a mano.
        const esNotificacion = m?.id === undefined || m?.id === null;

        const auth = request.headers.get("authorization") ?? "";
        const { verifyMcpTicket } = await import("../server/mcp-ticket.server");
        const ticket = verifyMcpTicket(auth.startsWith("Bearer ") ? auth.slice(7) : "");
        if (!ticket) {
          if (esNotificacion) return new Response(null, { status: 202 });
          return err(m.id, -32001, "ticket inválido o vencido");
        }
        // El namespace se resuelve por HOST, igual que en `api.connectors.tools.ts`: la caja
        // pega al subdominio de su tenant. Un ticket de otro workspace no entra aunque esté
        // bien firmado — el secreto es global a la plataforma.
        const { currentNamespace } = await import("../server/tenant.server");
        const aqui = await currentNamespace().catch(() => null);
        if (!aqui || aqui !== ticket.ns) {
          if (esNotificacion) return new Response(null, { status: 202 });
          return err(m.id, -32001, "ticket de otro workspace");
        }

        if (esNotificacion) return new Response(null, { status: 202 });

        switch (m.method) {
          case "initialize": {
            // Eco de la versión que pide el cliente si la conocemos; si no, la nuestra. La
            // spec dice explícitamente que NO se responde con error: se ofrece la propia y
            // el cliente decide si sigue.
            const pedida = typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : "";
            return rpc(m.id, {
              result: {
                protocolVersion: VERSIONES.includes(pedida) ? pedida : VERSIONES[0],
                // Sólo `tools`. Omitir `resources` y `prompts` ES la forma de decir que no
                // los hay: un cliente conforme no los pedirá.
                capabilities: { tools: {} },
                serverInfo: { name: "ghosty", version: "1" },
              },
            });
          }
          case "ping":
            return rpc(m.id, { result: {} });
          case "tools/list":
          case "tools/call": {
            const turns = await import("../server/turns.server");
            const quien = turns.inflightAuthority(ticket.groupId);
            // Sin turno en vuelo el agente no está trabajando para nadie. Puede ser que ya
            // terminó, que lo detuvieron, o que dos se solaparon y no se sabe a nombre de
            // quién actuaría. En los tres casos, nada.
            if (!quien || !quien.invokerSub || quien.publicChannel) {
              // Una lista VACÍA y no un error: así el agente ve que ahora no hay
              // herramientas en vez de creer que el servidor está roto.
              if (m.method === "tools/list") return rpc(m.id, { result: { tools: [] } });
              return err(m.id, -32002, "no hay un turno en curso a nombre de nadie");
            }
            const { listUserTools, runTool } = await import("../server/connectors/tools.server");
            const dest = quien.dest as never;
            const scope = quien.scope as never;
            if (m.method === "tools/list") {
              const tools = await listUserTools(quien.invokerSub, dest, scope);
              return rpc(m.id, {
                result: {
                  tools: tools.map((t: any) => ({
                    name: t.name,
                    description: t.description,
                    inputSchema: t.inputSchema ?? { type: "object", properties: {} },
                  })),
                },
              });
            }
            const nombre = typeof m.params?.name === "string" ? m.params.name : "";
            if (!nombre) return err(m.id, -32602, "falta el nombre de la herramienta");
            const r = await runTool(quien.invokerSub, nombre, m.params?.arguments ?? {}, dest, scope);
            // MCP no tiene "resultado con error de negocio": lo que devuelve la tool va como
            // contenido y `isError` marca el fallo. Devolverlo como error de JSON-RPC haría
            // que el agente lo leyera como "el servidor se rompió" y reintentara.
            return rpc(m.id, {
              result: {
                content: [{ type: "text", text: typeof r === "string" ? r : JSON.stringify(r) }],
                isError: (r as any)?.ok === false,
              },
            });
          }
          default:
            return err(m.id, -32601, `no soportado: ${m.method}`);
        }
      },
    },
  },
});
