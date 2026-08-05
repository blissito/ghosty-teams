import { createFileRoute } from "@tanstack/react-router";

// ── La marca del workspace como hoja de estilo ──────────────────────────────
// Un `<link>` en el <head> BLOQUEA el render, así que la marca está puesta antes del
// primer paint: cero FOUC y cero JS. La alternativa —serializar el kit dentro de
// THEME_BOOT— obligaba a que el shell tuviera datos del servidor, que es justo lo que
// un `shellComponent` no puede pedir cómodamente.
//
// La precedencia sale GRATIS de la cascada:
//   1. styles.css        → la paleta de Ghosty (el suelo)
//   2. esta hoja         → la marca del workspace
//   3. estilos inline    → el preset que la persona eligió en Ajustes → Apariencia
// El kit cambia el punto de partida del workspace; no le quita el tema a nadie.
//
// `:root:root` a propósito: duplicar el selector sube la especificidad por encima del
// `:root` de styles.css sin depender del ORDEN en que Vite emita los <link>. Sigue muy
// por debajo de un estilo inline, que es lo que queremos.

export const Route = createFileRoute("/api/brand-css")({
  server: {
    handlers: {
      GET: async () => {
        let css = "";
        try {
          const { activeBrandKit } = await import("../server/brand.server");
          const { brandPalette, brandFontStacks } = await import("../lib/brand-tokens");
          const kit = await activeBrandKit();
          if (kit) {
            const p = brandPalette(kit);
            const f = brandFontStacks(kit);
            const block = (pal: Record<string, string>) =>
              Object.entries(pal)
                .map(([k, v]) => `--color-${k}:${v}`)
                .join(";");
            css =
              `:root:root{${block(p.light)};--font-brand-heading:${f.heading}}\n` +
              `:root:root[data-theme="dark"]{${block(p.dark)}}\n`;
          }
        } catch {
          // Sin marca (o con la DB caída) la app se ve como siempre. Una hoja vacía es
          // 200, no 500: un 500 aquí pintaría un error de red en cada carga.
        }
        return new Response(css, {
          headers: {
            "Content-Type": "text/css; charset=utf-8",
            // Corto y revalidable: cambiar la marca tiene que verse al recargar, y la
            // hoja pesa unos cientos de bytes.
            "Cache-Control": "public, max-age=30, must-revalidate",
          },
        });
      },
    },
  },
});
