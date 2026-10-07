import { createFileRoute } from "@tanstack/react-router";

// ── Proxy git de la fábrica: la caja de @build clona y empuja por aquí ──────────────────────
// Smart HTTP (`info/refs`, `git-upload-pack`, `git-receive-pack`) hacia github.com con el token
// del bot inyectado; la caja sólo trae un token de sesión `gfp_` del pedido. El tenant sale del
// host (la caja pega al subdominio del espacio). Toda la lógica: `server/apps/factory-git.server.ts`.
async function handle({ request, params }: { request: Request; params: { runId: string; _splat?: string } }) {
  const { proxyGit } = await import("../server/apps/factory-git.server");
  return proxyGit(request, params.runId, params._splat ?? "");
}

export const Route = createFileRoute("/api/git/$runId/$")({
  server: { handlers: { GET: handle, POST: handle } },
});
