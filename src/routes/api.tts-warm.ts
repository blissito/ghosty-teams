import { createFileRoute } from "@tanstack/react-router";

// POST /api/tts-warm → 204, y despierta la caja de voz por detrás.
//
// La caja de `kokoro-svc` hiberna a los 900 s. Sin esto, el primer "leer en voz alta" del
// día paga el resume de la caja ADEMÁS de la síntesis, y el usuario lo vive como un botón
// que no responde. Se pega aquí al abrir un documento y al pasar el ratón por el botón de
// play: para cuando el dedo llega, la caja ya está en pie.
//
// Sin cuerpo y sin parámetros a propósito. Si aceptara texto sería un sintetizador abierto
// para cualquiera con sesión; así lo único que se puede provocar es despertar una caja que
// de todos modos se despierta sola al primer play (y `precalentarVoz` no deja pasar más de
// una cada 5 minutos, con o sin sesión de por medio).
export const Route = createFileRoute("/api/tts-warm")({
  server: {
    handlers: {
      POST: async () => {
        const { sessionUser } = await import("../server/chat");
        const me = await sessionUser();
        if (!me) return new Response(null, { status: 401 });

        const { precalentarVoz } = await import("../server/tts.server");
        // Fire-and-forget: quien llama no espera nada, sólo quiere que la caja arranque.
        void precalentarVoz().catch(() => {});
        return new Response(null, { status: 204 });
      },
    },
  },
});
