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
      GET: async ({ params, request }) => {
        // Modo demo (?demo=1): HTML canned emitido en pedacitos, SIN sesión. Existe para
        // COMPROBAR el transporte de punta a punta (¿llega en chunks o alguien lo
        // bufferea: Nitro, Caddy, el iframe?). Contenido estático, no toca datos.
        if (new URL(request.url).searchParams.get("demo")) {
          const enc = new TextEncoder();
          const parts = [
            `<!doctype html><html><head><script src="https://cdn.tailwindcss.com"></script>`,
            `<style>:root{--color-background:#0b1020;--color-primary:#8b5cf6}</style></head>`,
            `<body class="bg-[var(--color-background)] text-white p-10 font-sans">`,
            ...Array.from({ length: 8 }, (_, i) =>
              `<div class="mb-4 rounded-xl bg-[var(--color-primary)] p-6 text-2xl font-bold">bloque ${i + 1}</div>`
            ),
            `</body></html>`,
          ];
          let i = 0;
          const s = new ReadableStream<Uint8Array>({
            async pull(c) {
              if (i >= parts.length) return c.close();
              c.enqueue(enc.encode(parts[i++]));
              await new Promise((r) => setTimeout(r, 700));
            },
          });
          return new Response(s, {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store, no-transform",
              "Content-Security-Policy": "sandbox allow-scripts",
              "X-Accel-Buffering": "no",
            },
          });
        }
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

        // El body abre en el PRIMER chunk (ver lib/artifact-stream-doc: el navegador no
        // pinta nada mientras el HTML va en el <head>, así que abrimos el documento y todo
        // lo del agente entra dentro del body ya abierto). Probado en artifact-stream-doc.test.
        const { makeArtifactHtmlTransform } = await import("../lib/artifact-stream-doc");
        const transform = makeArtifactHtmlTransform();

        const enc = new TextEncoder();
        let sent = 0; // bytes de FUENTE ya consumidos → solo transformamos el SUFIJO nuevo
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
                const piece = transform(html.slice(sent));
                sent = html.length;
                if (piece) {
                  try { controller.enqueue(enc.encode(piece)); } catch { return finish(); }
                }
              }
              if (closed) finish();
            };
            // Abre el documento YA (aunque el agente aún no haya escrito nada): el iframe
            // deja de estar en blanco desde el instante en que se monta.
            try { controller.enqueue(enc.encode(transform(""))); } catch { return finish(); }
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
