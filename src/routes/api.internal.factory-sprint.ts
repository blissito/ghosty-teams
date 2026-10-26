import { createFileRoute } from "@tanstack/react-router";

// ── Endpoint interno: los sprints de la fábrica fuera de Teams ───────────────────
//
// Lo que hace la tarjeta del sprint (`SprintCard`: leer, editar, aprobar, pedir cambios,
// reintentar o saltar un ticket, dejarlo como issue) a nombre de una persona que llega por gs
// (la app de iOS y `ghosty factory sprints`). Mismas funciones que la web (`factory.ts`, con el
// miembro en vez de la sesión) y mismo permiso: ver el room; editar y aprobar, el dueño o quien
// lo pidió.
//
//   POST {action:"ls", sub}                                   → {sprints:[…]}
//   POST {action:"get"|"approve", sprintId, sub}              → el sprint (forma de `readSprint`)
//   POST {action:"edit", sprintId, itemId, included?, title?, bodyMd?, sub}
//   POST {action:"changes", sprintId, note, sub}
//   POST {action:"item", sprintId, itemId, op:"retry"|"skip", sub}
//   POST {action:"issue", sprintId, itemId, sub}
//
// Firma de partner sobre el CUERPO en crudo (`ts.<rawBody>`), como `api/internal/post-message`.

const bad = (error: string, status = 400) => Response.json({ error }, { status });

type Body = {
  action?: string;
  sprintId?: number;
  itemId?: number;
  included?: boolean;
  title?: string;
  bodyMd?: string;
  note?: string;
  op?: string;
  sub?: string;
};

export const Route = createFileRoute("/api/internal/factory-sprint")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const raw = await request.text();
        if (!((await import("../server/partner-sig.server")).partnerRequestOk(request, raw))) {
          return new Response("firma inválida", { status: 403 });
        }
        let body: Body;
        try {
          body = JSON.parse(raw) as Body;
        } catch {
          return bad("json inválido");
        }
        if (!body.sub) return bad("falta sub");
        const users = await import("../users.server");
        const member = (await users.listAllMembers().catch(() => [])).find((m) => m.sub === body.sub && !m.banned);
        if (!member) return bad("no eres miembro de este espacio de Teams (entra una vez desde el navegador)", 403);
        const { isOwner } = await users.resolvePermissions(member.email, member.isOwner);
        const me = { sub: member.sub, name: member.name, avatar: member.avatar, isOwner };
        const F = await import("../server/apps/factory");

        try {
          if (body.action === "ls") {
            const db = await import("../db.server");
            const rooms = await db.listChannels(me.sub, isOwner);
            if (!rooms.length) return Response.json({ sprints: [] });
            const slug = new Map(rooms.map((c) => [c.id, c.slug]));
            const { dbq } = await import("../dbq.server");
            // Borradores y activos siempre; los terminados o cancelados, sólo los de 14 días.
            const rows = await dbq(
              `SELECT s.id, s.channel_id, s.root_msg_id, s.card_msg_id, s.title, s.status, s.repo, s.created_at, s.updated_at,
                      SUM(CASE WHEN i.included = 1 THEN 1 ELSE 0 END) AS total,
                      SUM(CASE WHEN i.included = 1 AND i.status IN ('merged','skipped') THEN 1 ELSE 0 END) AS merged
               FROM gt_factory_sprints s LEFT JOIN gt_factory_sprint_items i ON i.sprint_id = s.id
               WHERE s.channel_id IN (${rooms.map(() => "?").join(",")})
                 AND (s.status IN ('draft','active') OR s.updated_at > unixepoch() - 14 * 86400)
               GROUP BY s.id ORDER BY s.updated_at DESC LIMIT 50`,
              rooms.map((c) => c.id),
            );
            return Response.json({
              sprints: rows.map((r) => ({
                id: Number(r.id),
                title: String(r.title),
                status: String(r.status),
                repo: r.repo ?? null,
                room: slug.get(Number(r.channel_id)) ?? null,
                threadId: Number(r.root_msg_id ?? r.card_msg_id) || null,
                total: Number(r.total ?? 0),
                merged: Number(r.merged ?? 0),
                createdAt: Number(r.created_at),
                updatedAt: Number(r.updated_at),
              })),
            });
          }
          const sprintId = Number(body.sprintId);
          if (!sprintId) return bad("falta sprintId");
          const itemId = Number(body.itemId);
          switch (body.action) {
            case "get":
              return Response.json(await F.readSprint(sprintId, me));
            case "approve":
              return Response.json(await F.sprintApprove({ sprintId }, me));
            case "edit":
              if (!itemId) return bad("falta itemId");
              return Response.json(await F.sprintEdit({ sprintId, itemId, included: body.included, title: body.title, bodyMd: body.bodyMd }, me));
            case "changes":
              return Response.json(await F.sprintChanges({ sprintId, note: String(body.note ?? "") }, me));
            case "item":
              if (!itemId) return bad("falta itemId");
              if (body.op !== "retry" && body.op !== "skip") return bad("op: retry | skip");
              return Response.json(await F.sprintItem({ sprintId, itemId, action: body.op }, me));
            case "issue":
              if (!itemId) return bad("falta itemId");
              return Response.json(await F.sprintIssue({ sprintId, itemId }, me));
          }
          return bad("action: ls | get | approve | edit | changes | item | issue");
        } catch (e) {
          return bad((e as Error).message, 409);
        }
      },
    },
  },
});
