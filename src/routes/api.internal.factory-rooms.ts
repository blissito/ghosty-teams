import { createFileRoute } from "@tanstack/react-router";

// ── Endpoint interno: rooms de la fábrica desde la terminal ─────────────────────
//
// `ghosty factory rooms ls|connect|disconnect` (19-oct): crear un room y conectarle un repo sin
// abrir Teams, para que un agente de terminal deje lista la fábrica antes de pedirle algo. Hace lo
// mismo que el ícono de GitHub del room (`addRoomRepoFn`/`removeRoomRepoFn`) y que «Nuevo room»
// (`createChannelFn`), a nombre de quien llega por gs (`sub`), con sus mismos permisos.
//
// Diferencia a propósito con la UI: antes de conectar se comprueba que la GitHub App de quien
// conecta VEA el repo. En la UI se elige de una lista; en la terminal un typo conectaba un repo
// que no existe y la fábrica fallaba mucho después, en el primer @build.
//
// Firma de partner sobre el CUERPO en crudo (`ts.<rawBody>`), como `api/internal/post-message`.

async function verify(ts: string, sig: string, rawBody: string): Promise<boolean> {
  const crypto = await import("node:crypto");
  const secret = process.env.GHOSTY_PARTNER_SECRET;
  if (!secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) <= 300;
}

const bad = (error: string, status = 400, extra: Record<string, unknown> = {}) => Response.json({ error, ...extra }, { status });

type Body = { action?: string; room?: string; repo?: string; create?: boolean; private?: boolean; sub?: string };

export const Route = createFileRoute("/api/internal/factory-rooms")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const raw = await request.text();
        if (!(await verify(request.headers.get("x-ghosty-ts") ?? "", request.headers.get("x-ghosty-sig") ?? "", raw))) {
          return new Response("firma inválida", { status: 403 });
        }
        let body: Body;
        try {
          body = JSON.parse(raw) as Body;
        } catch {
          return bad("json inválido");
        }
        if (!body.sub || body.sub.startsWith("guest:")) return bad("falta sub");
        await (await import("../server/schema.server")).ensureSchema().catch(() => {});
        const db = await import("../db.server");
        const users = await import("../users.server");
        const member = (await users.listAllMembers().catch(() => [])).find((m) => m.sub === body.sub && !m.banned);
        if (!member) return bad("no eres miembro de este espacio de Teams (entra una vez desde el navegador)", 403);
        const { isOwner } = await users.resolvePermissions(member.email, member.isOwner);
        const { isInstalled } = await import("../server/apps/installed.server");
        const factoryInstalled = await isInstalled("factory").catch(() => false);

        if (body.action === "ls") {
          const channels = await db.listChannels(member.sub, isOwner);
          const rooms = [];
          for (const ch of channels) {
            if (ch.archived) continue;
            const repos = await db.listRoomRepos(ch.id);
            rooms.push({ slug: ch.slug, name: ch.name, private: !!ch.is_private, repos: repos.map((r) => r.repo), factory: factoryInstalled && repos.length > 0 });
          }
          return Response.json({ factoryInstalled, rooms });
        }

        const { normalizeRepo, allTools } = await import("../server/connectors/github.server");
        const repo = normalizeRepo(String(body.repo ?? ""));
        if (!repo) return bad('el repositorio va como "dueño/repo"');
        const roomName = String(body.room ?? "").replace(/^#/, "").trim();
        if (!roomName) return bad("falta el room");
        // Por slug o por nombre, entre los que ve; uno privado ajeno «no existe» (y crear choca de slug, no de room).
        const visible = await db.listChannels(member.sub, isOwner);
        let ch = visible.find((c) => c.slug === roomName.toLowerCase() || c.name.toLowerCase() === roomName.toLowerCase()) ?? null;

        if (body.action === "disconnect") {
          if (!ch) return bad(`no hay un room «${roomName}» que veas`, 404);
          const fila = (await db.listRoomRepos(ch.id)).find((r) => r.repo.toLowerCase() === repo.toLowerCase());
          if (!fila) return bad(`${repo} no está conectado a #${ch.slug}`, 404);
          if (!isOwner && fila.connectedBy !== member.sub) return bad("lo conectó otra persona: que lo quite ella o el dueño del espacio", 403);
          await db.removeRoomRepo(ch.id, fila.repo);
          return Response.json({ ok: true, room: ch.slug, repos: (await db.listRoomRepos(ch.id)).map((r) => r.repo) });
        }

        if (body.action !== "connect") return bad("action: ls | connect | disconnect");

        // ¿La GitHub App de quien conecta alcanza el repo? Misma tool que el selector de la UI.
        const list = allTools().find((t) => t.name === "github_list_repos");
        const seen = list
          ? ((await list.handler(member.sub, {}).catch(() => null)) as { repos?: { repo: string }[]; installUrl?: string; addMoreUrl?: string; error?: string } | null)
          : null;
        if (!seen?.repos?.some((r) => r.repo.toLowerCase() === repo.toLowerCase())) {
          const url = seen?.addMoreUrl ?? seen?.installUrl ?? null;
          return bad(
            seen?.error && !seen.repos
              ? `tu GitHub no está conectado a Ghosty: ${seen.error}`
              : `la GitHub App de Ghosty no ve ${repo} con tu cuenta${url ? `: dale acceso en ${url}` : ""}`,
            409,
            { installUrl: url },
          );
        }

        let created = false;
        if (!ch) {
          if (!body.create) return bad(`no existe el room «${roomName}»: agrega --create para crearlo`, 404);
          ch = await db.createChannel({
            name: roomName,
            description: `Software Factory de ${repo}: pide aquí con @plan, @build construye y @check revisa.`,
            isPrivate: !!body.private,
            createdBy: member.sub,
          });
          created = true;
        }
        await db.addRoomRepo(ch.id, repo, member.sub);

        // Con la fábrica instalada, como `addRoomRepoFn`: el repo entra a la caja de CI del espacio
        // y su homepage al uptime. Aquí se espera la caja: el CLI dice con qué runner quedó.
        let ciLabel: string | null = null;
        if (factoryInstalled) {
          const { requestCiBox } = await import("../server/apps/factory");
          ciLabel = await requestCiBox([repo]);
          void import("../server/apps/uptime.server").then((U) => U.autoMonitorRepo(ch!.id, repo, member.sub)).catch(() => {});
        }
        const { repoReadiness } = await import("../server/apps/readiness.server");
        const rd = await repoReadiness(member.sub, repo, { fresh: true }).catch(() => null);
        const readiness = rd && !("error" in rd) ? { level: rd.level, passed: rd.passed, total: rd.total, missing: rd.checks.filter((c) => !c.ok).map((c) => c.key) } : null;
        console.log(`[factory-rooms] ${member.name} conectó ${repo} → #${ch.slug}${created ? " (nuevo)" : ""}`);
        return Response.json({ ok: true, room: ch.slug, created, repo, factoryInstalled, ciLabel, readiness, repos: (await db.listRoomRepos(ch.id)).map((r) => r.repo) });
      },
    },
  },
});
