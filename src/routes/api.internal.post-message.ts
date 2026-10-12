import { createFileRoute } from "@tanstack/react-router";

// ── Endpoint interno: escribir en un room o hilo COMO una persona y despertar a quien mencione ──
//
// Lo llama gs (`ghosty teams post <espacio>#<room>[/<hilo>] "…"`). Antes no había forma de mandar
// un pedido a @plan sin el navegador: `schedule-turn` abre un turno firmado «Ghosty Studio» sin
// mensaje de la persona, y el composer saca la identidad de la cookie. El pedido del CI de
// mailmask (12-oct) se tuvo que mandar desde el Chrome de bliss.
//
// Es la MISMA secuencia que el composer y «Pedir» (`ask-in-room.ts`): `postMessageAs` deja el
// mensaje y las cáscaras, y `askAgentAs` arranca el turno de cada respondent, con la persona que
// gs firmó en vez de la cookie. Así valen igual el filtro de varios @, el auto-seguir del hilo, el
// steer y el tope de relevos.
//
// Firma de partner sobre el cuerpo crudo (`ts.<rawBody>`), como `schedule-turn`. El namespace lo
// resuelve el HOST. gs ya comprobó que `sub` es miembro (o staff dentro) del espacio, y aquí se
// vuelve a mirar: a diferencia de `schedule-turn` NO hay respaldo al dueño, porque el mensaje sale
// firmado con su nombre.
//
//   POST {action:"post", channel, parentId?, text, sub}   → {id, threadId, channel, respondents, unresolved}
//   POST {action:"replies", channel, threadId, after}     → {replies:[{id, handle, name, body, live}]}

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

type Body = { action?: string; channel?: string | number; parentId?: number | null; threadId?: number; after?: number; text?: string; sub?: string };

export const Route = createFileRoute("/api/internal/post-message")({
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
        await (await import("../server/schema.server")).ensureSchema().catch(() => {});
        const db = await import("../db.server");
        if (!body.channel || !body.sub) return bad("faltan channel o sub");
        const ch = typeof body.channel === "number" || /^\d+$/.test(String(body.channel))
          ? await db.getChannelById(Number(body.channel))
          : await db.getChannel(String(body.channel).replace(/^#/, ""));
        if (!ch) return bad(`no hay un room «${body.channel}» en este espacio`, 404);

        // Quien escribe: miembro no baneado de este Teams. Nunca a nombre de otro.
        const users = await import("../users.server");
        const member = (await users.listAllMembers().catch(() => [])).find((m) => m.sub === body.sub && !m.banned);
        if (!member) return bad("no eres miembro de este espacio de Teams (entra una vez desde el navegador)", 403);
        const { isOwner } = await users.resolvePermissions(member.email, member.isOwner);
        if (!(await db.canSeeChannel(ch, member.sub, isOwner))) return bad(`no tienes acceso a #${ch.slug}`, 403);

        if (body.action === "replies") {
          const threadId = Number(body.threadId);
          const after = Number(body.after) || 0;
          const root = threadId ? await db.getMessage(threadId) : null;
          if (!root || root.channel_id !== ch.id) return bad("hilo no encontrado", 404);
          const { currentNamespace } = await import("../server/tenant.server");
          const { turnState } = await import("../server/turns.server");
          const ns = await currentNamespace();
          const replies = (await db.listThread(threadId))
            .filter((m) => m.id > after && m.agent_handle && m.sender_sub == null && m.kind === "msg")
            .map((m) => ({ id: m.id, handle: m.agent_handle, name: m.sender, body: m.body ?? "", live: !!turnState(ns, m.id) }));
          return Response.json({ replies });
        }

        if (body.action !== "post") return bad("action: post | replies");
        const text = String(body.text ?? "").trim();
        if (!text) return bad("falta el texto");
        if (text.length > 8000) return bad("el mensaje pasa de 8,000 caracteres");

        // Hilo: tiene que ser un mensaje RAÍZ de ese room.
        const parentId = body.parentId ? Number(body.parentId) : null;
        if (parentId) {
          const root = await db.getMessage(parentId);
          if (!root || root.channel_id !== ch.id || root.dm_id != null) return bad(`el mensaje ${parentId} no es de #${ch.slug}`, 404);
          if (root.parent_id) return bad(`el mensaje ${parentId} es una respuesta; usa el del inicio del hilo (${root.parent_id})`);
        }

        const { postMessageAs, askAgentAs } = await import("../server/chat");
        const me = { sub: member.sub, name: member.name, avatar: member.avatar, isOwner };
        const r = await postMessageAs(me, { slug: ch.slug, parentId, body: text });
        if (!r.ok) return bad("no se pudo publicar");
        // El turno corre después de contestar (como el `void askAgent` del cliente): el CLI no se
        // queda colgado y `--wait` pregunta por las respuestas.
        for (const ag of r.respondents) {
          void askAgentAs(me, {
            slug: ch.slug,
            parentId: ag.parent,
            fleetThread: ag.fleetThread,
            body: text,
            sender: "",
            handle: ag.handle,
            shellId: ag.shellId || undefined,
            invokerMessageId: r.id,
          }).catch((e) => console.error(`[post-message] @${ag.handle}:`, e instanceof Error ? e.message : e));
        }
        console.log(`[post-message] ${member.name} → #${ch.slug}${parentId ? `/${parentId}` : ""} id=${r.id} respondents=${r.respondents.map((x) => x.handle).join(",") || "-"}`);
        return Response.json({
          id: r.id,
          threadId: parentId ?? r.id,
          channel: ch.slug,
          respondents: r.respondents.map((x) => ({ handle: x.handle, steered: !!x.steered })),
          unresolved: r.unresolved,
        });
      },
    },
  },
});
