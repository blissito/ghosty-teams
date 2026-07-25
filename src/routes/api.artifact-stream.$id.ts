import { createFileRoute } from "@tanstack/react-router";

// ── Artefacto EN CONSTRUCCIÓN servido como respuesta HTTP en chunks ──────────
// Es EL MISMO iframe del resultado final, solo que apuntado desde el primer token:
// el panel pone <iframe src="/api/artifact-stream/:id"> UNA vez y el navegador
// pinta el HTML conforme llega, exactamente como cualquier página en carga.
//
// Por qué no bastaba re-emitir `srcDoc` con el HTML parcial: cada re-emisión
// REMONTA el iframe → el parser reinicia y el <script src="cdn.tailwindcss.com">
// (render-blocking, ~300ms) vuelve a empezar. Con un tick de 250ms el frame nunca
// alcanzaba a pintar y solo se veía el resultado al detenerse el stream.
//
// El body en curso vive en el bus in-proceso (bus.liveBody/tapBody). Aislamiento:
// `CSP: sandbox` → origen opaco, sin acceso a la sesión ni al DOM del panel, aunque
// el HTML venga del agente. `no-transform` evita que Caddy comprima y BUFFEREE los
// chunks (con buffer se pierde justo lo que queremos: el goteo).
export const Route = createFileRoute("/api/artifact-stream/$id")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { useSession } = await import("@tanstack/react-start/server");
        const { sessionConfig } = await import("../server/session.server");
        const s = await useSession<{ user?: { sub: string } }>(sessionConfig());
        if (!s.data.user) return new Response("unauthorized", { status: 401 });

        const bus = await import("../server/bus.server");
        const { currentNamespace } = await import("../server/tenant.server");
        const { extractEbDoc } = await import("../lib/ebdoc");
        const ns = await currentNamespace();
        const id = Number(params.id);
        if (!Number.isFinite(id)) return new Response("bad id", { status: 400 });

        const htmlOf = (body: string | null): { html: string; closed: boolean } => {
          const doc = body ? extractEbDoc(body) : null;
          if (!doc || doc.kind !== "artifact") return { html: "", closed: false };
          return { html: doc.md, closed: doc.closed };
        };

        const enc = new TextEncoder();
        let sent = 0; // bytes de HTML ya escritos → solo mandamos el SUFIJO nuevo
        let unsub = () => {};
        let idle: ReturnType<typeof setTimeout> | undefined;

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              unsub();
              if (idle) clearTimeout(idle);
              try { controller.close(); } catch { /* ya cerrado */ }
            };
            const push = (body: string | null) => {
              if (done) return;
              const { html, closed } = htmlOf(body);
              if (html.length > sent) {
                try { controller.enqueue(enc.encode(html.slice(sent))); } catch { return finish(); }
                sent = html.length;
              }
              if (closed) finish();
            };
            // Lo que ya se escribió antes de que el panel abriera este stream.
            push(bus.liveBody(ns, id));
            unsub = bus.tapBody(ns, id, push);
            // Red de seguridad: si el turno muere sin cerrar el fence, no dejamos la
            // conexión colgada para siempre.
            idle = setTimeout(finish, 5 * 60_000);
            idle.unref?.();
          },
          cancel() {
            unsub();
            if (idle) clearTimeout(idle);
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store, no-transform",
            "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups",
            "X-Content-Type-Options": "nosniff",
            "X-Accel-Buffering": "no",
          },
        });
      },
    },
  },
});
