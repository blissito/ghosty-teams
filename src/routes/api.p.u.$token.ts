import { createFileRoute } from "@tanstack/react-router";

// GET/POST /api/p/u/<token> → baja de un clic.
//
// Los DOS métodos, y no es redundancia:
//  · POST lo dispara el cliente de correo cuando el header `List-Unsubscribe-Post` está
//    presente (Gmail, Yahoo). El usuario aprieta "cancelar suscripción" en la interfaz de
//    Gmail y nunca sale de ahí.
//  · GET es el enlace visible del pie, para quien lo abre a mano.
//
// ⚠️ La baja se aplica SIN pedir confirmación. Una pantalla de "¿estás seguro?" es
// exactamente lo que hace que la gente use el botón de spam en su lugar — y una queja de
// spam cuesta reputación de dominio, mientras que una baja no cuesta nada.
//
// Se dan de baja el correo Y el teléfono de esa fila: quien no quiere saber de nosotros no
// quiere saber por ningún canal, y dejarle el WhatsApp abierto sería leer el opt-out al pie
// de la letra en contra de lo que la persona quiso decir.
export const Route = createFileRoute("/api/p/u/$token")({
  server: {
    handlers: {
      GET: async ({ params }: { params: { token: string } }) => applyUnsubscribe(params.token),
      POST: async ({ params }: { params: { token: string } }) => applyUnsubscribe(params.token, true),
    },
  },
});

async function applyUnsubscribe(token: string, isPost = false): Promise<Response> {
  const { verifyTrackToken } = await import("../server/prospeccion/track.server");
  const c = verifyTrackToken(token || "");

  let ok = false;
  if (c && c.kind === "unsub") {
    try {
      const { withNamespace } = await import("../server/tenant.server");
      await withNamespace(c.ns, async () => {
        const { getTouch } = await import("../server/prospeccion/touches.server");
        const { getRow, setRowStatus } = await import("../server/prospeccion/lists.server");
        const { addOptOut } = await import("../server/prospeccion/optout.server");

        const t = await getTouch(c.touchId);
        if (!t) return;
        const row = await getRow(t.rowId);
        if (!row) return;

        if (row.email) await addOptOut("email", row.email, "unsubscribe");
        if (row.phone) await addOptOut("phone", row.phone, "unsubscribe");
        await setRowStatus(row.id, "optout");
        ok = true;

        const { publish, ch } = await import("../server/bus.server");
        publish(ch.presence(c.ns), { t: "refresh", channelId: null, parentId: null });
      });
    } catch {
      ok = false;
    }
  }

  // El POST del cliente de correo no enseña nada: sólo necesita un 200.
  if (isPost) return new Response(null, { status: 200 });

  // Y para quien abrió el enlace, una página que confirma y ya. Sin marca, sin
  // "nos vas a extrañar", sin oferta de última hora: eso es lo que se siente a burla.
  const body_ = ok
    ? `<h1>Listo</h1><p>No vas a recibir más emails nuestros.</p>`
    : `<h1>Este enlace ya no sirve</h1><p>Si sigues recibiendo emails, responde a cualquiera de ellos y lo arreglamos.</p>`;

  return new Response(
    `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Baja</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 system-ui, -apple-system, sans-serif; margin: 0;
         min-height: 100vh; display: grid; place-items: center;
         background: #fafafa; color: #1a1a1a; padding: 24px; }
  @media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } }
  main { max-width: 380px; text-align: center; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { margin: 0; opacity: .7; font-size: 14px; }
</style></head><body><main>${body_}</main></body></html>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
