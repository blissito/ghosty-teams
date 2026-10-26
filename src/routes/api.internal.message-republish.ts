import { createFileRoute } from "@tanstack/react-router";

// ── Endpoint interno: publicar el ```eb-doc``` que quedó crudo en un mensaje ────────────────
//
// Reparación para burbujas que prometen «Documento listo — ábrelo en el panel» y no tienen
// artefacto: el fence quedó guardado en el body sin publicarse (relevos antes del 26-oct,
// descti #1005). Corre el MISMO camino que un turno (`publishEbDocFromReply`). Idempotente:
// si el mensaje ya tiene artefacto, no hace nada. Lo llama staff desde gs con la firma de
// partner; el namespace lo da el host, como en las demás rutas internas.

export const Route = createFileRoute("/api/internal/message-republish")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const raw = await request.text();
        const ok = (await import("../server/partner-sig.server")).partnerRequestOk(request, raw);
        if (!ok) return new Response("firma inválida", { status: 403 });
        const { messageId } = JSON.parse(raw) as { messageId?: number };
        if (!Number.isInteger(messageId)) return new Response("falta messageId", { status: 400 });

        const db = await import("../db.server");
        const msg = await db.getMessage(messageId!);
        if (!msg) return Response.json({ ok: false, error: "no existe" }, { status: 404 });
        const { dbq } = await import("../dbq.server");
        const has = await dbq("SELECT id FROM gc_artifacts WHERE message_id = ? LIMIT 1", [messageId]);
        if (has.length) return Response.json({ ok: true, skipped: "ya tiene artefacto" });

        const bus = await import("../server/bus.server");
        const { currentNamespace } = await import("../server/tenant.server");
        const ns = await currentNamespace();
        const inDm = msg.dm_id != null;
        const parentId = msg.parent_id ?? null;
        const currentDocId = inDm
          ? await db.getDmArtifact(msg.dm_id!).catch(() => null)
          : await db.resolveThreadArtifact(msg.channel_id, parentId).catch(() => null);
        const currentDoc = currentDocId ? await db.getDoc(currentDocId).catch(() => null) : null;
        const { publishEbDocFromReply } = await import("../server/ebdoc-publish.server");
        const body = await publishEbDocFromReply({
          messageId: messageId!,
          reply: msg.body ?? "",
          ownerSub: null,
          currentDocId,
          currentDoc,
          setPointer: (docId) =>
            inDm ? db.setDmArtifact(msg.dm_id!, docId) : db.setThreadArtifact(msg.channel_id, parentId, docId),
          notify: () => bus.publish(bus.ch.room(ns, msg.channel_id), { t: "refresh", channelId: msg.channel_id, parentId }),
        });
        if (body == null) return Response.json({ ok: false, error: "el mensaje no trae un eb-doc cerrado" });
        await db.setMessageBody(messageId!, body);
        bus.publish(bus.ch.room(ns, msg.channel_id), { t: "message:body", id: messageId!, body });
        return Response.json({ ok: true });
      },
    },
  },
});
