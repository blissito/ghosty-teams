import { createFileRoute } from "@tanstack/react-router";

// ── Subida de adjuntos (Fase 4) ─────────────────────────────────────────────
// POST multipart/form-data con campo `file`. Autentica con gc_session, sube los
// bytes a EasyBits (storage privado) server-side (evita CORS browser→Tigris) y
// devuelve el fileId + metadata. El cliente adjunta esos fileIds al enviar el
// mensaje; el render los sirve vía /api/attachment/:id.
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB
/** A un invitado, menos: sube desde una liga pública y no tiene cuenta que responda. */
const GUEST_MAX_BYTES = 8 * 1024 * 1024;

type Invitado = { ok: false; error?: string; status?: number } | { ok: true; sub: string; channelId: number };

/**
 * ¿Este invitado puede subir a este room, y le queda cuota?
 *
 * Se comprueba con `eventViewerFor` —la MISMA puerta del chat y de la llamada— y con el
 * limitador de siempre. Un invitado sin correo verificado no llega aquí.
 */
async function guestUpload(slug: string): Promise<Invitado> {
  const { channelByShareSlug } = await import("../db.server");
  const ch = await channelByShareSlug(slug);
  if (!ch || !ch.call_mode) return { ok: false };
  const { eventViewerFor } = await import("../server/events/access.server");
  const viewer = await eventViewerFor(ch).catch(() => null);
  if (!viewer) return { ok: false };

  const { rateCheck } = await import("../server/forms/rate.server");
  const { allowed } = await rateCheck(`evtup:${ch.id}`, viewer.sub, {
    scope: "evtup",
    windowS: 3600,
    maxWithIp: 10,
    maxNoIp: 10,
  });
  if (!allowed) return { ok: false, error: "Ya subiste varios archivos. Espera un rato.", status: 429 };
  return { ok: true, sub: viewer.sub, channelId: ch.id };
}

/**
 * Le pega un PASE firmado al fileId cuando quien subió es un invitado.
 *
 * ⚠️ Sin esto, `eventPostFn` tendría que creerle al cliente qué `fileId` adjunta, y
 * bastaría conocer el de otro room para colgarlo aquí. El pase ata el archivo a QUIEN lo
 * subió y a QUÉ room, y se verifica al publicar el mensaje. Un miembro no lo necesita:
 * su camino ya pasa por la sesión.
 */
async function conPase<T extends { fileId: string }>(up: T, inv: Invitado) {
  if (!inv.ok) return up;
  const { signUploadPass } = await import("../server/events/upload-pass.server");
  return { ...up, pass: await signUploadPass(up.fileId, inv.sub, inv.channelId) };
}

export const Route = createFileRoute("/api/upload")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const { useSession } = await import("@tanstack/react-start/server");
        const { sessionConfig } = await import("../server/session.server");
        const s = await useSession<{ user?: { sub: string } }>(sessionConfig());
        let invitado: Invitado = { ok: false };
        // Segunda puerta: un producto hermano del ecosistema (Ghosty Tasks) firmando con
        // GHOSTY_PARTNER_SECRET. Su cookie no cruza subdominios, y sin esto tendría que
        // montar su propio bucket o mandarle la imagen al agente en base64 —
        // duplicando storage o inflando el contexto del turno.
        //
        // Se firma `ts.upload` (el cuerpo es multipart y no se puede canonicalizar
        // barato) con ventana de 300s: es permiso para subir UN archivo, ahora.
        if (!s.data.user) {
          const secret = process.env.GHOSTY_PARTNER_SECRET;
          const url = new URL(request.url);
          const ts = url.searchParams.get("ts") ?? "";
          const sig = url.searchParams.get("sig") ?? "";
          let ok = false;
          if (secret && ts && sig) {
            const crypto = await import("node:crypto");
            const expected = crypto.createHmac("sha256", secret).update(`${ts}.upload`).digest("hex");
            const a = Buffer.from(sig);
            const b = Buffer.from(expected);
            ok =
              a.length === b.length &&
              crypto.timingSafeEqual(a, b) &&
              Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) <= 300;
          }
          // Tercera puerta: un INVITADO verificado de un room abierto. Va con `?room=<slug>`
          // porque un invitado no es "de todo el workspace": lo es de UN room, y de ahí
          // salen su cuota y sus límites.
          if (!ok) {
            const url2 = new URL(request.url);
            const slug = url2.searchParams.get("room") ?? "";
            if (slug) {
              const g = await guestUpload(slug);
              if (g.ok) { invitado = g; ok = true; }
              else if (g.error) return new Response(g.error, { status: g.status ?? 403 });
            }
          }
          if (!ok) return new Response("unauthorized", { status: 401 });
        }

        let form: FormData;
        try {
          form = await request.formData();
        } catch {
          return new Response("bad request", { status: 400 });
        }
        const file = form.get("file");
        if (!(file instanceof File)) return new Response("no file", { status: 400 });
        if (file.size === 0) return new Response("empty file", { status: 400 });
        if (file.size > MAX_BYTES) return new Response("file too large", { status: 413 });

        // ⚠️ A un invitado se le aprieta más que a un miembro, y a propósito: cien
        // desconocidos escribiendo en el storage de un cliente es la superficie de abuso
        // más cara de todo el room abierto.
        if (invitado.ok) {
          const tipo = (file.type || "").toLowerCase();
          const permitido = tipo.startsWith("image/") || tipo === "application/pdf";
          if (!permitido) return new Response("solo imágenes o PDF", { status: 415 });
          if (file.size > GUEST_MAX_BYTES) return new Response("archivo demasiado grande", { status: 413 });
        }

        const isImage = (file.type || "").startsWith("image/");
        try {
          if (isImage) {
            // Imagen → pipeline con thumbnail WebP (sirve el derivado inline; original para
            // vista completa / agente). Devuelve thumbFileId (o null si no aplica/sharp ausente).
            const { processAndStoreImage } = await import("../server/image.server");
            const up = await processAndStoreImage({
              blob: file,
              contentType: file.type || "application/octet-stream",
              fileName: file.name || `file-${file.size}`,
            });
            return Response.json(await conPase(up, invitado));
          }
          const { uploadToEasyBits } = await import("../server/easybits-files.server");
          const up = await uploadToEasyBits({
            blob: file,
            contentType: file.type || "application/octet-stream",
            fileName: file.name || `file-${file.size}`,
          });
          return Response.json(await conPase(up, invitado));
        } catch (err) {
          return new Response(`upload failed: ${(err as Error).message}`, { status: 502 });
        }
      },
    },
  },
});
