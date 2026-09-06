// Avisos de operación de Teams → gs, que es quien tiene los canales.
//
// Aquí NO se manda correo ni WhatsApp a propósito: las credenciales de esos
// canales viven en gs y no tienen por qué estar en la caja multitenant. Teams
// sólo firma y cuenta lo que le pasó.
//
// ⚠️ Nunca lanza y nunca espera mucho: esto se llama desde el manejador de una
// promesa rechazada, o sea desde el peor momento posible para añadir otro fallo.

export async function alertar(a: {
  key: string;
  title: string;
  detail?: string;
}): Promise<void> {
  try {
    const secret = process.env.GHOSTY_PARTNER_SECRET;
    if (!secret) return;
    const IDP = process.env.GHOSTY_IDENTITY_URL ?? "https://www.ghosty.studio";
    const crypto = await import("node:crypto");
    const body = JSON.stringify({ key: a.key, title: a.title, detail: a.detail?.slice(0, 2000) });
    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    await fetch(`${IDP}/internal/alert`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ghosty-ts": String(ts), "x-ghosty-sig": sig },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Un aviso que no sale no puede convertirse en un segundo incidente.
  }
}
