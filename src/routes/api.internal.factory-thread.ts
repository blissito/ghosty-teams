import { createFileRoute } from "@tanstack/react-router";

// ── Endpoint interno: un pedido a @plan visto desde fuera de Teams ───────────────
//
// La app de iOS manda «@plan …» por `post-message` y luego necesita VER qué pasó: @plan no
// siempre arma un pedido para firmar. Puede proponer un sprint, publicar ideas (`gt-asks`) o
// sólo contestar o preguntar (bliss, 19-oct: «se manda el pedido pero nada regresa»). Una sola
// llamada para el sondeo: el hilo entero, el run que nació en él, el sprint propuesto en él y si
// alguien sigue trabajando.
//
//   POST {channel, threadId, after?, sub} → {root, messages:[…], run|null, sprint|null, working}
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

const bad = (error: string, status = 400) => Response.json({ error }, { status });

type Body = { channel?: string | number; threadId?: number; after?: number; sub?: string };

export const Route = createFileRoute("/api/internal/factory-thread")({
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
        if (!body.channel || !body.sub) return bad("faltan channel o sub");
        const db = await import("../db.server");
        const ch = typeof body.channel === "number" || /^\d+$/.test(String(body.channel))
          ? await db.getChannelById(Number(body.channel))
          : await db.getChannel(String(body.channel).replace(/^#/, ""));
        if (!ch) return bad(`no hay un room «${body.channel}» en este espacio`, 404);
        const users = await import("../users.server");
        const member = (await users.listAllMembers().catch(() => [])).find((m) => m.sub === body.sub && !m.banned);
        if (!member) return bad("no eres miembro de este espacio de Teams (entra una vez desde el navegador)", 403);
        const { isOwner } = await users.resolvePermissions(member.email, member.isOwner);
        if (!(await db.canSeeChannel(ch, member.sub, isOwner))) return bad(`no tienes acceso a #${ch.slug}`, 403);

        const threadId = Number(body.threadId);
        const root = threadId ? await db.getMessage(threadId) : null;
        if (!root || root.channel_id !== ch.id || root.parent_id) return bad("hilo no encontrado", 404);

        const { currentNamespace } = await import("../server/tenant.server");
        const { turnState } = await import("../server/turns.server");
        const ns = await currentNamespace();
        const after = Number(body.after) || 0;
        // Con artefactos: una pregunta `ask-user` vive ahí (pregunta en `title`, opciones en `md`).
        const thread = await db.attachArtifacts(await db.listThread(threadId));
        const view = (m: (typeof thread)[number]) => {
          const art = m.artifact?.kind === "ask-user" ? m.artifact : null;
          let ask: { question: string; options: string[]; answered: string | null } | null = null;
          if (art) {
            try {
              const raw = JSON.parse(art.md ?? "[]") as string[] | { options: string[]; answered?: string };
              ask = Array.isArray(raw)
                ? { question: art.title ?? "", options: raw, answered: null }
                : { question: art.title ?? "", options: raw.options ?? [], answered: raw.answered ?? null };
            } catch {}
          }
          return {
            id: m.id,
            from: m.agent_handle && m.sender_sub == null ? "agent" : "person",
            handle: m.agent_handle,
            name: m.sender,
            avatar: m.avatar,
            body: m.body ?? "",
            at: m.created_at,
            kind: m.kind,
            live: !!turnState(ns, m.id),
            ask,
          };
        };
        const messages = thread.filter((m) => m.id > after && m.kind === "msg").map(view);
        const working = thread.some((m) => !!turnState(ns, m.id)) || !!turnState(ns, root.id);

        const R = await import("../server/apps/factory-runs.server");
        const run = await R.runOfThread(ch.id, threadId).catch(() => null);
        const { dbq } = await import("../dbq.server");
        const sp = await dbq(
          `SELECT id FROM gt_factory_sprints WHERE channel_id = ? AND (root_msg_id = ? OR card_msg_id = ? OR card_msg_id IN (SELECT id FROM gc_messages WHERE parent_id = ?))
           ORDER BY id DESC LIMIT 1`,
          [ch.id, threadId, threadId, threadId],
        ).catch(() => []);
        const me = { sub: member.sub, name: member.name, avatar: member.avatar, isOwner };
        const F = await import("../server/apps/factory");
        const sprint = sp[0] ? await F.readSprint(Number(sp[0].id), me).catch(() => null) : null;

        return Response.json({
          channel: ch.slug,
          root: { ...view(root), from: "person" },
          messages,
          run: run ? { id: run.id, status: run.status, title: run.title ?? null } : null,
          sprint,
          working,
        });
      },
    },
  },
});
