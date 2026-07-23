import { createFileRoute } from "@tanstack/react-router";

// ── Dispatch de tools de conectores (runtime nativo → Teams) ─────────────────────
// El runtime de agentes de Studio pega aquí para (a) DESCUBRIR las tools per-user de un
// turno (`action:"list"`) y (b) EJECUTARLAS cuando el agente las invoca (`action:"run"`).
// Los handlers viven en Teams porque usan las creds per-user (gc_user_connectors).
//
// Auth = partner-HMAC (misma GHOSTY_PARTNER_SECRET del handshake de identidad), NO sesión:
// el llamador es el runtime, no un browser. El `sub` (usuario del turno) va en el body y se
// confía porque la firma prueba que el emisor es el runtime. `runTool`/`listUserTools` ya
// acotan a los conectores CONECTADOS de ese sub → un sub no alcanza tools ajenas.
//
// Body: { sub: string, action: "list" } → { tools: ToolDecl[] }
//       { sub: string, action: "run", name: string, args?: object } → RunResult
export const Route = createFileRoute("/api/connectors/tools")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const raw = await request.text();
        const { verifyPartner } = await import("../server/ghosty-runtime.server");
        const ok = verifyPartner(raw, request.headers.get("x-ghosty-ts"), request.headers.get("x-ghosty-sig"));
        if (!ok) return new Response(JSON.stringify({ error: "firma inválida" }), { status: 401, headers: { "Content-Type": "application/json" } });

        let body: { sub?: string; action?: string; name?: string; args?: Record<string, unknown> };
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          return new Response(JSON.stringify({ error: "body inválido" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        const sub = typeof body.sub === "string" ? body.sub : "";
        if (!sub) return new Response(JSON.stringify({ error: "falta sub" }), { status: 400, headers: { "Content-Type": "application/json" } });

        const { listUserTools, runTool } = await import("../server/connectors/tools.server");
        const json = (data: unknown, status = 200) =>
          new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

        if (body.action === "list") return json({ tools: await listUserTools(sub) });
        if (body.action === "run") {
          if (!body.name) return json({ error: "falta name" }, 400);
          return json(await runTool(sub, body.name, body.args ?? {}));
        }
        return json({ error: "action debe ser 'list' o 'run'" }, 400);
      },
    },
  },
});
