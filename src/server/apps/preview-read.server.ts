// Que el agente VEA la preview sin ver la llave (`?k=`): la plataforma abre la ruta con la cookie `gs_preview`
// y le devuelve estado, título y texto visible. La llave se queda aquí; nunca sale en la respuesta.
import { previewAuth } from "./factory-smoke.server";

export type PreviewPage = { path: string; status: number | null; title: string | null; text: string; truncated: boolean } | { path: string; error: string };

const MAX_TEXT = 3000;

/** Título y texto visible de un HTML (sin scripts ni estilos). Puro. */
export function readablePage(html: string): { title: string | null; text: string; truncated: boolean } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim() || null;
  const body = html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return { title, text: body.slice(0, MAX_TEXT), truncated: body.length > MAX_TEXT };
}

/** Una ruta de la MISMA preview: «/algo» (nunca «//otro-host» ni una URL entera). */
export function safePreviewPath(path: string): string | null {
  const p = String(path ?? "").trim();
  return p.startsWith("/") && !p.startsWith("//") && !/[\s\\]/.test(p) ? p : null;
}

export async function readPreviewPage(keyedUrl: string | null, path: string, hit: typeof fetch = fetch): Promise<PreviewPage> {
  const safe = safePreviewPath(path);
  if (!safe) return { path: String(path), error: "la ruta debe empezar con «/» y ser de la misma preview" };
  if (!keyedUrl) return { path: safe, error: "la preview no está lista" };
  try {
    const { origin, cookie } = previewAuth(keyedUrl);
    const res = await hit(origin + safe, { headers: cookie ? { cookie } : {}, redirect: "manual", signal: AbortSignal.timeout(20_000) });
    const { title, text, truncated } = readablePage(await res.text().catch(() => ""));
    return { path: safe, status: res.status, title, text, truncated };
  } catch {
    return { path: safe, error: "la preview no contestó (timeout o red)" };
  }
}
