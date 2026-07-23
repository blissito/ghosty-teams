import { createFileRoute } from "@tanstack/react-router";

// ── Dispatch de tools de conectores (worker/box → Teams) ─────────────────────────
// El agente (dentro del box) corre un script del GS Tools SDK (`connectors.mjs`) que pega
// aquí para (a) DESCUBRIR sus tools per-user (`action:"list"`) y (b) EJECUTARLAS
// (`action:"run"`). Los handlers viven en Teams porque usan las creds per-user
// (gc_user_connectors) — el box nunca ve el token del proveedor.
//
// Auth = token-CAPACIDAD firmado (`Authorization: Bearer <toolToken>`): Teams lo minta al
// mandar el turno con el `sub` del invocador dentro (firmado). El box lo reenvía; aquí se
// VERIFICA → el `sub` sale del token (el agente no puede forjar otro). El namespace del
// tenant se resuelve por host (el box pega al subdominio del tenant). runTool ya acota a
// los conectores CONECTADOS de ese sub.
//
// Body: { action: "list" } → { tools: ToolDecl[] }
//       { action: "run", name: string, args?: object } → RunResult
export const Route = createFileRoute("/api/connectors/tools")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const json = (data: unknown, status = 200) =>
          new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

        const auth = request.headers.get("authorization") ?? "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        const { verifyToolToken } = await import("../server/connectors/tool-token.server");
        const claims = verifyToolToken(token);
        if (!claims) return json({ error: "token inválido o expirado" }, 401);
        const sub = claims.sub;

        let body: { action?: string; name?: string; args?: Record<string, unknown> };
        try {
          body = await request.json();
        } catch {
          return json({ error: "body inválido" }, 400);
        }

        const { listUserTools, runTool } = await import("../server/connectors/tools.server");
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
