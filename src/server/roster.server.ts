// El padrón del workspace vive en ghosty.studio (`Workspace` + `Membership`), no en
// `gc_users`: esa tabla es una proyección que se escribe cuando alguien ENTRA. Por eso
// a un miembro recién agregado —o a uno que usa Ghosty Tasks y todavía no ha abierto
// Teams— no se le encontraba para meterlo a un room privado.
import crypto from "node:crypto";
import { currentSlug } from "./tenant.server";

const IDP = process.env.GHOSTY_IDENTITY_URL ?? "https://www.ghosty.studio";
const TTL_MS = 60_000;

export type RosterEntry = { sub: string; role: string; email: string };

const cache = new Map<string, { v: RosterEntry[]; exp: number }>();

export async function workspaceRoster(): Promise<RosterEntry[]> {
  const slug = await currentSlug();
  if (!slug) return [];
  const hit = cache.get(slug);
  if (hit && hit.exp > Date.now()) return hit.v;
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto
    .createHmac("sha256", process.env.GHOSTY_PARTNER_SECRET!)
    .update(`${ts}.${slug}`)
    .digest("hex");
  try {
    const r = await fetch(
      `${IDP}/internal/workspace-members/${encodeURIComponent(slug)}?ts=${ts}&sig=${sig}`,
      { signal: AbortSignal.timeout(3000) }
    );
    if (!r.ok) throw new Error(`roster ${r.status}`);
    const b = (await r.json()) as { members?: RosterEntry[] };
    const v = (b.members ?? []).map((m) => ({ sub: m.sub, role: m.role, email: (m.email ?? "").toLowerCase() }));
    cache.set(slug, { v, exp: Date.now() + TTL_MS });
    return v;
  } catch {
    // Un hipo de gs no debe romper el invitar: se sirve lo último conocido, y si no
    // hay nada se cae al camino local.
    return hit?.v ?? [];
  }
}
