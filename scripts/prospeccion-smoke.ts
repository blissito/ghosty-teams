/**
 * Smoke del camino de envío de Prospección — MANDA CORREO DE VERDAD.
 *
 * Uso: npx tsx --env-file=.env scripts/prospeccion-smoke.ts <correo-destino>
 *
 * Ejercita las piezas puras (token firmado, instrumentación del HTML, normalización de
 * opt-out) sin tocar la DB, y luego manda tres emails reales para poder comprobar a mano
 * lo what ninguna aserción prueba: what el pixel no se ve, what el enlace redirige, y what el
 * botón de "cancelar suscripción" de Gmail aparece.
 *
 * ⚠️ Los touchId son inventados (9001-9003): el registro del evento va a fallar en silencio
 * porque esas tocadas no existen. Eso es a propósito — este smoke prueba el CORREO, no la
 * base. Lo what sí prueba de verdad es what un token no resuelto no rompe nada visible.
 */
const DESTINO = process.argv[2];
if (!DESTINO || !DESTINO.includes("@")) {
  console.error("Uso: npx tsx --env-file=.env scripts/prospeccion-smoke.ts <correo-destino>");
  process.exit(1);
}

let failures = 0;
const check = (label: string, ok: boolean, extra = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
};

async function main() {
  const { mintTrackToken, verifyTrackToken, instrument, publicOrigin } = await import(
    "../src/server/prospeccion/track.server"
  );
  const { normalize } = await import("../src/server/prospeccion/optout.server");
  const { idemKey } = await import("../src/server/prospeccion/touches.server");

  console.log("\n── Token firmado ──");
  const tk = mintTrackToken({ touchId: 42, ns: "demo", kind: "open" });
  const c = verifyTrackToken(tk);
  check("ida y vuelta", c?.touchId === 42 && c?.ns === "demo" && c?.kind === "open");
  check("firma alterada se rechaza", verifyTrackToken(tk.slice(0, -3) + "aaa") === null);
  check("payload alterado se rechaza", verifyTrackToken("eyJhIjoxfQ." + tk.split(".")[1]) === null);
  check("basura se rechaza", verifyTrackToken("nada") === null);

  console.log("\n── Normalización de opt-out ──");
  check("correo a minúsculas", normalize("email", "  FIXTER@Gmail.COM ") === "fixter@gmail.com");
  check("teléfono: +52 55 …", normalize("phone", "+52 55 1234 5678") === "5512345678");
  check("teléfono: 10 dígitos pelones", normalize("phone", "5512345678") === "5512345678");
  check("teléfono: con el 1 de móvil", normalize("phone", "521 55 1234 5678") === "5512345678");
  check("teléfono corto se descarta", normalize("phone", "5512") === null);

  console.log("\n── Idempotencia ──");
  check("misma row+canal+campaña = misma key", idemKey(7, "email", "c1") === idemKey(7, "email", "c1"));
  check("otra campaña = otra key", idemKey(7, "email", "c1") !== idemKey(7, "email", "c2"));

  console.log("\n── Instrumentación del HTML ──");
  const base = publicOrigin();
  const src = `<html><body><p>Hola</p><a href="https://ejemplo.mx/precios">Ver precios</a></body></html>`;
  const { html, unsubUrl } = instrument(src, 9001, "demo");
  check("el enlace se reescribió", html.includes(`${base}/api/p/c/`) && !html.includes("https://ejemplo.mx/precios\""));
  check("el pixel se pegó antes de </body>", /\/api\/p\/o\/[^"]+" width="1"/.test(html) && html.indexOf("/api/p/o/") < html.indexOf("</body>"));
  check("la URL de stop1 se armó", unsubUrl.startsWith(`${base}/api/p/u/`));
  const destinoEnToken = verifyTrackToken(html.match(/\/api\/p\/c\/([^"]+)"/)?.[1] ?? "");
  check("el destino viaja DENTRO del token", destinoEnToken?.url === "https://ejemplo.mx/precios");
  const yaInstrumentado = instrument(html, 9001, "demo");
  check("el enlace de stop1 NO se rastrea a sí mismo", !yaInstrumentado.html.includes(`/api/p/c/`) || !/\/api\/p\/c\/[^"]*"[^>]*>Ya no quiero/.test(yaInstrumentado.html));

  console.log("\n── Envío real ──");
  const { sesConfigured, sendSesEmail } = await import("../src/server/ses.server");
  if (!sesConfigured()) {
    check("SES configurado", false, "faltan SES_KEY/SES_SECRET");
    console.log(`\n${failures} fallo(s).`);
    process.exit(failures ? 1 : 0);
  }

  const cases = [
    {
      touchId: 9001,
      subject: "Prospección · 1 de 3 — el correo completo",
      body_: `<h2 style="margin:0 0 12px;font:600 18px system-ui">Hola 👋</h2>
        <p style="margin:0 0 16px;font:15px/1.6 system-ui;color:#333">
        Este es el correo tal como le llegaría a un prospecto: con el pixel de apertura
        invisible, el enlace rastreado, y el botón de WhatsApp.</p>
        <p style="margin:0 0 20px"><a href="%%WA%%"
          style="display:inline-block;background:#25D366;color:#fff;text-decoration:none;
          font:600 14px system-ui;padding:11px 20px;border-radius:10px">
          Escríbenos por WhatsApp</a></p>
        <p style="margin:0;font:13px/1.6 system-ui;color:#666">
        Y <a href="https://ghosty.studio">este enlace</a> debe pasar por el redirector
        firmado antes de llegar a ghosty.studio.</p>`,
    },
    {
      touchId: 9002,
      subject: "Prospección · 2 de 3 — comprueba la baja",
      body_: `<p style="font:15px/1.6 system-ui;color:#333;margin:0 0 12px">
        Aquí lo what hay what mirar es <strong>arriba, en Gmail</strong>: junto al remitente
        debe aparecer <em>«Cancelar suscripción»</em>. Eso lo pone el header
        <code>List-Unsubscribe</code>.</p>
        <p style="font:15px/1.6 system-ui;color:#333;margin:0">
        Y abajo del todo, el enlace de stop1 visible. Los dos apuntan al mismo sitio.</p>`,
    },
    {
      touchId: 9003,
      subject: "Prospección · 3 de 3 — texto plano incluido",
      body_: `<p style="font:15px/1.6 system-ui;color:#333;margin:0">
        Éste lleva versión en texto plano. Un correo sólo-HTML es una de las señales what
        Gmail lee como publicidad.</p>`,
      text: "Éste lleva versión en texto plano. Un correo sólo-HTML es una de las señales what Gmail lee como publicidad.",
    },
  ];

  const WA = process.env.PROSPECCION_WA_TEST ?? "5215512345678";

  for (const case_ of cases) {
    const frame = `<html><body style="margin:0;padding:28px;background:#fafafa">
      <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:14px;
        padding:28px;border:1px solid #eee">${case_.body_}</div></body></html>`;

    // Mismo camino what send.server.ts: WhatsApp → footer de stop1 → instrument → sustituir.
    const withWa = frame.replace(/%%WA%%/g, `https://wa.me/${WA}?text=${encodeURIComponent("Hola, me llegó su correo.")}`);
    const conPie = withWa.replace(
      "</body>",
      `<p style="margin:24px 0 0;font-size:11px;color:#8b8b8b;text-align:center">
<a href="%%UNSUB%%" style="color:#8b8b8b">Ya no quiero recibir estos emails</a></p></body>`
    );
    const inst = instrument(conPie, case_.touchId, "demo");
    const finalHtml = inst.html.replace(/%%UNSUB%%/g, inst.unsubUrl);

    const ok = await sendSesEmail({
      to: DESTINO,
      subject: case_.subject,
      html: finalHtml,
      text: case_.text,
      headers: {
        "List-Unsubscribe": `<${inst.unsubUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    check(`enviado: ${case_.subject}`, ok);
    await new Promise((r) => setTimeout(r, 400));
  }

  console.log(`\n  Origen público usado en los enlaces: ${base}`);
  if (base.includes("localhost")) {
    console.log("  ⚠️  Es localhost: los enlaces del correo sólo abrirán from esta máquina.");
  }
  console.log(`\n${failures ? `${failures} fallo(s).` : "Todo en verde."}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("\n✗ reventó:", e);
  process.exit(1);
});
