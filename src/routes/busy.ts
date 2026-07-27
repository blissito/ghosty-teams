import { createFileRoute } from "@tanstack/react-router";

// ── VETO de hibernación (GET /busy) ─────────────────────────────────────────
//
// El daemon (sandbox-host) consulta esta ruta ANTES de congelar la microVM y solo procede
// si contesta 200 con `busy:false`. Cualquier otra cosa — 404, 307, timeout, 500 — cuenta
// como OCUPADO: no se hiberna lo que no se puede verificar.
//
// Por qué existe este archivo: `/busy` no era una ruta, así que caía en el catch-all del
// SPA y el guard de sesión de __root.tsx lo rebotaba a /login con un **307**. El daemon lo
// leía como "no sé" y jamás dormía esta caja — 2 GB de RAM retenidos para siempre y un
// reintento cada 30 s en el journal. Falla segura, pero capacidad tirada.
//
// Va en la RAÍZ (`/busy`, no `/api/busy`) porque es el path fijo que sondea el daemon, y
// como server handler (igual que api.warm.ts) para no pasar por el guard de sesión: el
// daemon llama sin cookie y sin token.
//
// Definición de "ocupado": trabajo EN CURSO, no presencia. Un turno de agente a medias sí;
// una pestaña abierta sin hacer nada no (ver agentTurnsInflight en agents.server.ts: si
// contáramos pestañas, esta caja no dormiría nunca y no habríamos arreglado nada).
export const Route = createFileRoute("/busy")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const { agentTurnsInflight } = await import("../agents.server");
          const inflight = agentTurnsInflight();
          return Response.json({ busy: inflight > 0, inflight });
        } catch (e) {
          // Si ni siquiera se puede mirar, hay que declararse OCUPADO: mejor una caja
          // encendida de más que una congelada a mitad de una respuesta.
          return Response.json({ busy: true, error: String(e).slice(0, 120) });
        }
      },
    },
  },
});
