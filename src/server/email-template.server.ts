// LA plantilla de correo de Ghosty. Una sola, para todo lo que sale del producto.
//
// Antes había tres: la de notificaciones (ésta, que era la buena y vivía enterrada en
// `notify.server.ts`), una tarjeta sosa en `email-send.server.ts` y otra distinta para las
// invitaciones a documentos. Mismo remitente, tres voces — y las dos copias no tenían nada de
// lo que hace que ésta funcione: el mascot INCRUSTADO, y tablas anidadas en vez de flex.
//
// Lo que NO se toca al editar este archivo, porque cada cosa costó una tarde:
//
// - **Tablas anidadas, nunca flex ni grid.** Outlook usa el motor de Word para maquetar.
// - **`mascot-mail.png`, y no los íconos del PWA**: ésos traen el fondo oscuro horneado y
//   sobre la tarjeta clara se ven como un cuadro negro.
// - **La colita del globo va con el truco de bordes** (un div de 0×0). Si un cliente la
//   descarta, queda un globo sin colita — que se ve bien igual.
// - **El mascot va por `cid:`**, no enlazado. Enlazarlo costaba una petición al abrir el
//   correo (500ms medidos, casi todo handshake TLS contra OVH) para traer 1.5KB, y dependía
//   de que el destinatario aceptara "mostrar imágenes de este remitente".
import type { InlineImage } from "./ses.server";

/**
 * Quién recibe esto, que decide el PIE.
 *
 * `workspace` — alguien del equipo: su pie lleva la ruta al opt-out.
 * `externo` — alguien de fuera (el abogado, el contador): NO se le puede prometer
 *   "Ajustes → Notificaciones", porque no tiene ajustes ni activó nada. Decirlo sería
 *   simplemente falso, y en un correo frío la letra chica es lo que se lee para decidir si
 *   esto es legítimo o spam.
 */
export type EmailFooter = "workspace" | "externo" | { text: string };

export type GhostyEmail = {
  /** El renglón grande dentro del globo. */
  head: string;
  /** Prosa bajo el título. SIEMPRE se escapa: puede venir de un modelo. */
  body?: string;
  /** Botón. Opcional — un correo de sólo texto no necesita uno, y hasta hoy era obligatorio. */
  cta?: { label: string; url: string };
  footer?: EmailFooter;
  /** "Brendi" → el pie externo dice quién escribe. Sin esto, sólo el producto. */
  deQuien?: string;
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/** "Título — detalle" o "Título\ndetalle" → sus dos partes. Sin corte natural, todo es título. */
export function splitHead(text: string): { head: string; rest: string } {
  const t = (text || "").trim();
  const m = /^(.{3,70}?)\s+—\s+([\s\S]+)$/.exec(t) || /^(.{3,70})\n+([\s\S]+)$/.exec(t);
  return m ? { head: m[1].trim(), rest: m[2].trim() } : { head: t, rest: "" };
}

/**
 * El mascot como imagen INCRUSTADA (cid:), no enlazada. Ver el encabezado del archivo.
 * Si el archivo no está (build sin public), se cae al enlace de siempre.
 */
let mascotCache: InlineImage | null | undefined;
export function mascotInline(): InlineImage | null {
  if (mascotCache !== undefined) return mascotCache;
  mascotCache = null;
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    for (const dir of [".output/public", "public", "build/client"]) {
      const p = path.resolve(process.cwd(), dir, "mascot-mail.png");
      if (fs.existsSync(p)) {
        mascotCache = { cid: "mascot", bytes: fs.readFileSync(p), mime: "image/png", fileName: "mascot.png" };
        break;
      }
    }
  } catch { /* sin disco → enlace remoto */
  }
  return mascotCache;
}

/** Base pública del tenant. `TEAMS_ROOT_DOMAIN` es un dominio PELADO: hay que vestirlo. */
export function publicBase(): string {
  const raw = process.env.PUBLIC_BASE_URL || process.env.TEAMS_ROOT_DOMAIN || "teams.ghosty.studio";
  return /^https?:\/\//.test(raw) ? raw.replace(/\/$/, "") : `https://${raw.replace(/\/$/, "")}`;
}

function pieTexto(f: EmailFooter, deQuien?: string): string {
  if (typeof f === "object") return f.text;
  if (f === "externo") {
    // Ni opt-out ni ajustes: esta persona no tiene cuenta. Lo único honesto que se le puede
    // decir es quién le escribe y desde dónde.
    return deQuien
      ? `Te escribe ${deQuien} desde Ghosty Teams. Si no esperabas este correo, puedes ignorarlo.`
      : "Enviado desde Ghosty Teams. Si no esperabas este correo, puedes ignorarlo.";
  }
  return "Recibes este correo porque lo activaste en Ghosty Studio. Puedes apagarlo en Ajustes → Notificaciones.";
}

/**
 * Arma el correo. Devuelve también el `inline` que hay que pasarle a `sendSesEmail` — si se
 * olvida, el mascot llega roto, así que van juntos a propósito.
 */
export function ghostyEmail(e: GhostyEmail): { html: string; text: string; inline: InlineImage[] } {
  const mascot = mascotInline();
  const base = publicBase();
  // Las IMÁGENES no pueden colgar del dominio del tenant: `teams.ghosty.studio` a secas no
  // resuelve (sólo los subdominios de workspace), así que el mascot llegaba roto. Van al
  // control-plane, que sí es un host público estable.
  const asset = (process.env.PUBLIC_ASSET_BASE || "https://www.ghosty.studio").replace(/\/$/, "");
  const cta = e.cta
    ? { label: e.cta.label, url: e.cta.url.startsWith("http") ? e.cta.url : `${base}${e.cta.url}` }
    : null;
  const pie = pieTexto(e.footer ?? "workspace", e.deQuien);

  const html = `<!doctype html><html><body style="margin:0;padding:28px 12px;background:#f5f5f7">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:540px;margin:0 auto;background:#f4f4f7;border:1px solid #e6e6ea;border-radius:16px">
    <tr><td style="padding:22px 24px 0;font:600 13px/1 system-ui,-apple-system,Segoe UI,sans-serif;color:#8a8a94;letter-spacing:.02em">Ghosty Studio</td></tr>

    <!-- Ghosty HABLANDO: mascot + globo de cómic. Dos celdas de tabla (no flex: Outlook no
         lo entiende). -->
    <tr><td style="padding:16px 24px 0">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
        <td width="64" valign="top" style="padding-right:2px">
          <img src="${mascot ? "cid:mascot" : `${asset}/mascot-mail.png`}" width="56" height="66" alt="Ghosty" style="display:block;border:0">
        </td>
        <td valign="top" style="padding-top:6px">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td valign="top" style="padding-top:14px">
              <div style="width:0;height:0;border-top:7px solid transparent;border-bottom:7px solid transparent;border-right:10px solid #ffffff;font-size:0;line-height:0">&nbsp;</div>
            </td>
            <td>
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#ffffff;border-radius:16px">
                <tr><td style="padding:14px 18px">
                  <div style="font:700 20px/1.3 system-ui,-apple-system,Segoe UI,sans-serif;color:#16161a">${escapeHtml(e.head)}</div>${e.body ? `
                  <div style="margin-top:6px;font:400 15px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;color:#3f3f46;white-space:pre-wrap">${escapeHtml(e.body)}</div>` : ""}
                </td></tr>
              </table>
            </td>
          </tr></table>
        </td>
      </tr></table>
    </td></tr>
${cta ? `
    <tr><td style="padding:20px 24px 26px 90px">
      <a href="${escapeHtml(cta.url)}" style="display:inline-block;background:#16161a;color:#fff;font:600 14px/1 system-ui,-apple-system,Segoe UI,sans-serif;padding:12px 18px;border-radius:9px;text-decoration:none">${escapeHtml(cta.label)}</a>
    </td></tr>` : `
    <tr><td style="padding:0 24px 8px">&nbsp;</td></tr>`}
    <tr><td style="padding:0 24px 22px">
      <div style="border-top:1px solid #e2e2e8;padding-top:14px;font:400 12px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#8a8a94">
        ${escapeHtml(pie)}
      </div>
    </td></tr>
  </table>
</body></html>`;

  // La misma información sin adornos. Un correo SÓLO-html es una de las señales que Gmail
  // lee como publicidad, y hay clientes que ni siquiera muestran html.
  const text = [e.head, e.body, cta?.url, `—\n${pie}`].filter(Boolean).join("\n\n");
  return { html, text, inline: mascot ? [mascot] : [] };
}
