import { createFileRoute } from "@tanstack/react-router";

// GET/POST /api/p/u/<token> → baja.
//
//  · POST la aplica. Lo dispara el cliente de correo con `List-Unsubscribe-Post` (Gmail,
//    Yahoo: un clic, RFC 8058) o el botón de la página de abajo.
//  · GET sólo enseña la página con UN botón «Darme de baja» (sin preguntas ni ofertas).
//
// ⚠️ GET NO da de baja. Los filtros de seguridad de las empresas (Proofpoint, Mimecast,
// Defender) abren TODAS las ligas de un correo al revisarlo: el 14-nov CASTELEC quedó «Dado de
// baja» segundos después del envío sin que nadie lo pidiera. RFC 8058 pide exactamente eso:
// la baja por POST y nunca por un GET que un escáner pueda seguir.
//
// Se dan de baja el correo Y el teléfono de esa fila: quien no quiere saber de nosotros no
// quiere saber por ningún canal, y dejarle el WhatsApp abierto sería leer el opt-out al pie
// de la letra en contra de lo que la persona quiso decir.
export const Route = createFileRoute("/api/p/u/$token")({
  server: {
    handlers: {
      GET: async ({ params }: { params: { token: string } }) => confirmPage(params.token),
      POST: async ({ params, request }: { params: { token: string }; request: Request }) => {
        // El botón de la página manda `confirm=1` y espera la página de «Listo»; el cliente de
        // correo manda `List-Unsubscribe=One-Click` y sólo necesita un 200.
        const body = await request.text().catch(() => "");
        return applyUnsubscribe(params.token, !/(^|&)confirm=1(&|$)/.test(body));
      },
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

  return page(body_);
}

/** La página del enlace del pie: un solo botón que hace el POST. Un escáner no la aprieta. */
async function confirmPage(token: string): Promise<Response> {
  const { verifyTrackToken } = await import("../server/prospeccion/track.server");
  const c = verifyTrackToken(token || "");
  if (!c || c.kind !== "unsub") return page(`<h1>Este enlace ya no sirve</h1><p>Si sigues recibiendo emails, responde a cualquiera de ellos y lo arreglamos.</p>`);
  const action = `/api/p/u/${encodeURIComponent(token)}`;
  return page(
    `<h1>¿Dejar de recibir estos correos?</h1>
<form method="post" action="${action}"><input type="hidden" name="confirm" value="1" /><button type="submit">Darme de baja</button></form>`,
  );
}

function page(body_: string): Response {
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
  form { margin: 16px 0 0; }
  button { font: inherit; font-size: 15px; padding: 10px 20px; border-radius: 10px; border: 1px solid #ccc;
           background: #1a1a1a; color: #fff; cursor: pointer; }
  @media (prefers-color-scheme: dark) { button { background: #eee; color: #111; border-color: #444; } }
</style></head><body><main>${body_}</main></body></html>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
