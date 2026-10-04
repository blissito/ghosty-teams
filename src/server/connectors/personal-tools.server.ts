// ── Modo PERSONAL: los conectores de Teams sin un espacio de Teams ───────────────
// Quien usa Ghosty sólo en gs (/c, apps) conecta GitHub, Calendly, Deník, Sentry u Odoo en
// ghosty.studio, y su agente usa estas tools igual. No hay espacio: gs firma el tool-token con
// `ns = personal:<sub>` y pega a `www.teams.ghosty.studio` (sin subdominio de tenant).
//
// Aquí sólo entran los conectores (nada de nativas, tablero, fábrica, Ads ni compartidas: todo
// eso vive en la base de un espacio, y el modo personal no tiene base — `dbqRaw` lo rechaza).
// La credencial se lee de gs por el puente con ese mismo ns (`studio-bridge.server.ts`).
import { PERSONAL_NS_PREFIX, withNamespace } from "../tenant.server";
import { loaderFor, toolsOf } from "./impl";
import type { RunResult, ToolDecl } from "./tools.server";

/** Conectores de Teams que funcionan sin espacio. */
export const PERSONAL_CONNECTORS = ["github", "calendly", "denik", "sentry", "odoo"] as const;
/** Tools que sólo tienen sentido dentro de un canal (avisan ahí): fuera del modo personal. */
const CHANNEL_ONLY = new Set(["github_watch_pr", "sentry_alerts_enable", "sentry_alerts_disable"]);

/** ¿Este token es de modo personal y de ESTA persona? (el ns lleva su propio sub). */
export const isPersonalClaim = (sub: string, ns: string | null): boolean => ns === `${PERSONAL_NS_PREFIX}${sub}`;

const connectorOf = (name: string) => PERSONAL_CONNECTORS.find((id) => name.startsWith(`${id}_`)) ?? null;
export const personalToolAllowed = (name: string): boolean => !CHANNEL_ONLY.has(name) && connectorOf(name) !== null;

export async function listPersonalTools(sub: string): Promise<ToolDecl[]> {
  return withNamespace(`${PERSONAL_NS_PREFIX}${sub}`, async () => {
    const { listConnectorProviders } = await import("./store.server");
    const connected = await listConnectorProviders(sub);
    const out: ToolDecl[] = [];
    for (const id of PERSONAL_CONNECTORS) {
      if (!connected.has(id)) continue;
      const load = loaderFor(id);
      if (!load) continue;
      try {
        for (const t of await toolsOf(await load(), sub, null))
          if (personalToolAllowed(t.name)) out.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
      } catch {
        // un conector roto no rompe el listado de los demás
      }
    }
    return out;
  });
}

export async function runPersonalTool(sub: string, name: string, args: Record<string, unknown>): Promise<RunResult> {
  if (!personalToolAllowed(name))
    return { ok: false, error: `${name} no está disponible fuera de un espacio de Ghosty Teams` };
  return withNamespace(`${PERSONAL_NS_PREFIX}${sub}`, async () => {
    const { runTool } = await import("./tools.server");
    return runTool(sub, name, args, null);
  });
}
