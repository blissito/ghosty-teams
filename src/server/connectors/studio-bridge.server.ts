// ── Conectores de Ghosty Studio, prestados a Teams ───────────────────────────
// Algunos conectores viven en gs (hoy Google Drive): se conectan una vez en
// ghosty.studio/app/connectors y sirven en /c, en las apps y aquí. El `sub` de Teams ES el
// `User.id` de gs (el login es con ghosty.studio), así que la cuenta que se usa es la de
// QUIEN ESCRIBE, igual que con los conectores propios de Teams.
//
// Del lado de gs: `app/routes/internal.connectors.tsx` (firma `ts.ns.sub.rawBody`).
import crypto from "node:crypto";

const STUDIO = (process.env.GHOSTY_IDENTITY_URL ?? "https://www.ghosty.studio").replace(/\/+$/, "");

/** Nombres de las tools que corren en gs. Prefijos reservados: ninguna de Teams empieza así. */
export const STUDIO_TOOL_PREFIXES = ["drive_", "hoja_", "documento_"];
export const isStudioTool = (name: string) => STUDIO_TOOL_PREFIXES.some((p) => name.startsWith(p));
/** Las que sólo leen: con un alcance acotado (`lectura`) son las únicas que se anuncian. */
export const STUDIO_READ_TOOLS = new Set(["drive_archivos", "drive_leer"]);

/** Liga de un clic para conectar (o elegir más archivos) un conector de gs. */
export const studioConnectUrl = (id: string) => `${STUDIO}/app/connectors?connect=${encodeURIComponent(id)}`;

export type StudioTool = { name: string; description: string; inputSchema: Record<string, unknown> };
export type StudioConnector = { id: string; nombre: string; descripcion: string; conectado: boolean; disponible: boolean; logo?: string | null };

async function call<T>(sub: string, body: Record<string, unknown>): Promise<T | null> {
  const secret = process.env.GHOSTY_PARTNER_SECRET;
  if (!secret || !sub) return null;
  const { currentNamespace } = await import("../tenant.server");
  const ns = await currentNamespace().catch(() => "");
  if (!ns) return null;
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = crypto.createHmac("sha256", secret).update(`${ts}.${ns}.${sub}.${raw}`).digest("hex");
  try {
    const r = await fetch(`${STUDIO}/internal/connectors`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ghosty-ts": ts, "x-ghosty-ws": ns, "x-ghosty-sub": sub, "x-ghosty-sig": sig },
      body: raw,
      signal: AbortSignal.timeout(body.action === "run" ? 60_000 : 8_000),
    });
    return (await r.json().catch(() => null)) as T | null;
  } catch {
    return null; // gs caído: los conectores de Teams siguen funcionando
  }
}

// El listado se pide en cada turno: 60 s de caché por persona bastan (conectar se nota al
// minuto, y `forgetStudioCache` lo hace inmediato al volver del panel).
const listCache = new Map<string, { at: number; tools: StudioTool[] }>();

export async function studioTools(sub: string): Promise<StudioTool[]> {
  const hit = listCache.get(sub);
  if (hit && Date.now() - hit.at < 60_000) return hit.tools;
  const r = await call<{ ok: boolean; tools?: StudioTool[] }>(sub, { action: "list" });
  const tools = r?.ok ? r.tools ?? [] : [];
  listCache.set(sub, { at: Date.now(), tools });
  return tools;
}

export function forgetStudioCache(sub: string): void {
  listCache.delete(sub);
}

export async function studioCatalog(sub: string): Promise<StudioConnector[]> {
  const r = await call<{ ok: boolean; connectors?: StudioConnector[] }>(sub, { action: "catalog" });
  return r?.ok ? r.connectors ?? [] : [];
}

export async function runStudioTool(
  sub: string,
  name: string,
  args: Record<string, unknown>,
  readOnly: boolean,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  const r = await call<{ ok: boolean; result?: unknown; error?: string }>(sub, { action: "run", name, args, readOnly });
  if (!r) return { ok: false, error: "Ghosty Studio no contestó; vuelve a intentarlo en un momento" };
  return r.ok ? { ok: true, result: r.result } : { ok: false, error: r.error ?? "error" };
}
