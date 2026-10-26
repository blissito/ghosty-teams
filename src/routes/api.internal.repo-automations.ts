import { createFileRoute } from "@tanstack/react-router";

// ── Endpoint interno: automatizaciones de GitHub de un room desde gs / la terminal ──────────
//
// Lo mismo que los switches del panel del repo (`setRoomRepoAutomationFn`), a nombre de quien
// llega por gs (`sub`) y con sus permisos: sólo rooms que esa persona ve y repos conectados.
//   { sub, action: "ls",  room, repo }
//   { sub, action: "set", room, repo, kind, enabled, settings? }
// Firma de partner sobre el CUERPO en crudo (`ts.<rawBody>`), como `api/internal/factory-rooms`.

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

const bad = (error: string, status = 400) => Response.json({ error }, { status });

type Body = { sub?: string; action?: string; room?: string; repo?: string; kind?: string; enabled?: boolean; settings?: Record<string, unknown> };

export const Route = createFileRoute("/api/internal/repo-automations")({
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
        if (!member) return bad("no eres miembro de este espacio de Teams", 403);
        const { isOwner } = await users.resolvePermissions(member.email, member.isOwner);
        const room = (await db.listChannels(member.sub, isOwner)).find((c) => !c.archived && (c.slug === body.room || String(c.id) === String(body.room)));
        if (!room) return bad("room no encontrado", 404);
        const linked = (await db.listRoomRepos(room.id)).find((r) => r.repo.toLowerCase() === String(body.repo ?? "").toLowerCase());
        if (!linked) return bad("ese repositorio no está conectado a este room", 404);
        const S = await import("../server/automations/store.server");
        const { AUTOMATION_CATALOG, isAutomationKind } = await import("../server/automations/catalog");
        if (body.action === "set") {
          if (!isAutomationKind(body.kind)) return bad("automatización desconocida");
          const { currentNamespace } = await import("../server/tenant.server");
          await S.setRepoAutomation({
            ns: await currentNamespace(),
            roomId: room.id,
            repo: linked.repo,
            kind: body.kind,
            enabled: body.enabled === true,
            settings: body.settings && typeof body.settings === "object" ? body.settings : undefined,
            by: member.sub,
            origin: await (await import("../origin.server")).reqOrigin().catch(() => ""),
          });
        } else if (body.action !== "ls") return bad("action: ls | set");
        const rows = new Map((await S.listRepoAutomations(room.id, linked.repo)).map((r) => [r.kind, r]));
        return Response.json({
          room: room.slug,
          repo: linked.repo,
          automations: AUTOMATION_CATALOG.map((a) => ({ kind: a.kind, name: a.name, enabled: rows.get(a.kind)?.enabled ?? false, settings: rows.get(a.kind)?.settings ?? {} })),
        });
      },
    },
  },
});
