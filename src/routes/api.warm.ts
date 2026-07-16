import { createFileRoute } from "@tanstack/react-router";

// ── Warm-up de arranque (calienta la caja antes del primer usuario) ──────────
// La microVM revive EN FRÍO: el primer request del usuario pagaba el pool de DB
// frío + las migraciones `ensureSchema` (addColumn/PRAGMA). El systemd de la caja
// pega aquí en `ExecStartPost` apenas bootea → las migraciones corren y el pool de
// libSQL abre su primera conexión ANTES de que llegue nadie. Sin sesión ni datos
// sensibles: solo dispara el trabajo idempotente. Barato, sin efectos secundarios.
export const Route = createFileRoute("/api/warm")({
  server: {
    handlers: {
      GET: async () => {
        const t0 = Date.now();
        try {
          const { ensureSchema } = await import("../server/schema.server");
          await ensureSchema(); // migraciones idempotentes (memoizadas tras la 1ª)
          const { dbq } = await import("../dbq.server");
          await dbq("SELECT 1"); // fuerza la 1ª conexión del pool (handshake en frío)
          return Response.json({ ok: true, ms: Date.now() - t0 });
        } catch (e) {
          // Un fallo aquí NO debe tumbar el boot; ensureSchema reintenta en el 1er
          // request real. Reporta para el log del ExecStartPost.
          return Response.json({ ok: false, ms: Date.now() - t0, error: String(e).slice(0, 120) }, { status: 503 });
        }
      },
    },
  },
});
