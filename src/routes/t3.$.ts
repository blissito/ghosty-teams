import { createFileRoute } from "@tanstack/react-router";

// GET /t3/<uuid>-name.html → sirve el HTML de un ARTEFACTO publicado, branded bajo
// artefacto.ghosty.studio (Caddy reverse_proxy → este app). PÚBLICO por definición
// (sin gc_session): un artefacto es un enlace compartible. El objeto vive en el bucket
// PRIVADO de Tigris (el "público" de Tigris no sirve objetos sin firma → AccessDenied);
// el app lo lee firmado y lo re-emite. Seguridad: `Content-Security-Policy: sandbox`
// fuerza origen opaco → el HTML no-confiable del agente NO puede tocar cookies/DOM de
// ghosty.studio. Fallback al bucket público para artefactos legacy (publicados antes
// del cambio a privado). Admin/revocación: borrar el objeto → 404.
export const Route = createFileRoute("/t3/$")({
  server: {
    handlers: {
      GET: async ({ params }: { params: { _splat?: string } }) => {
        const splat = params._splat ?? "";
        if (!splat || splat.includes("..")) return new Response("not found", { status: 404 });
        // PERMISO. Este link es un objeto del bucket y antes servía para siempre, así
        // que volver un artefacto a privado no revocaba nada: quien ya tenía la
        // dirección seguía leyéndolo. Ahora la key se resuelve a su documentId y se
        // aplica el MISMO permiso que en /artefacto/<slug>.
        //
        // El costo de DB es aceptable porque /t3 nunca fue CDN: ya era esta app leyendo
        // el objeto firmado. Se paga una consulta más por visita, no un hop nuevo.
        //
        // Una key que NO resuelve a ningún artefacto se sigue sirviendo: son las
        // publicadas antes de que existiera la noción de permiso, y negarlas rompería
        // links vivos sin proteger nada que alguien hubiera marcado como privado.
        let priv = false;
        try {
          const db = await import("../db.server");
          const documentId = await db.documentIdForStorageKey(splat);
          if (documentId) {
            const root = await db.shareRootFor(documentId);
            if (root && root.visibility !== "link") {
              const { sessionUser } = await import("../server/chat");
              const me = await sessionUser().catch(() => null);
              const isOwner = !!me && (!root.ownerSub || root.ownerSub === me.sub);
              // Igual que la página: no-existe y sin-acceso responden lo mismo.
              if (!isOwner) return new Response("not found", { status: 404 });
              priv = true;
            }
          }
        } catch (e) {
          // Un fallo al resolver NO puede abrir la puerta: sin veredicto, 404.
          console.error("[t3] permiso falló", e);
          return new Response("not found", { status: 404 });
        }
        // Tolera ambas formas de link: el nuevo /<uuid>-name.html (Caddy le antepone t3/) y
        // el viejo /t3/<uuid>-name.html (que tras el rewrite llega como t3/t3/…). Normaliza a
        // UNA sola key `t3/<uuid>-name.html` quitando cualquier prefijo t3/ redundante.
        const key = `t3/${splat.replace(/^(?:t3\/)+/, "")}`;
        const storage = await import("../server/storage.server");
        if (!storage.storageConfigured()) return new Response("storage off", { status: 503 });
        const bytes =
          (await storage.getBytes(key, "private")) ??
          (await storage.getBytes(key, "public").catch(() => null));
        if (!bytes) return new Response("not found", { status: 404 });
        return new Response(new Uint8Array(bytes), {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            // Aísla el documento standalone (origen opaco) — igual que el iframe in-Teams.
            "Content-Security-Policy":
              "sandbox allow-scripts allow-forms allow-popups allow-modals; base-uri 'none'",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            // Privado = sólo lo ve el dueño → ni el navegador ni un proxy pueden
            // quedarse una copia que sobreviva a la revocación.
            "Cache-Control": priv ? "private, no-store" : "public, max-age=300",
          },
        });
      },
    },
  },
});
