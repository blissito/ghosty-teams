// ── Espacios conocidos: despertarlos al arrancar el proceso ───────────────────
// Todo lo que corre solo (adopción de turnos durables, relevos de la fábrica, recordatorios,
// PRs vigilados) se arma en `ensureSchema`, que corre la PRIMERA vez que este proceso toca
// un tenant. Tras un deploy, un espacio que nadie abre se queda sin nada de eso: el
// 3-oct, los @build/@check de palmera-legal siguieron corriendo en gs pero Teams no los
// retomó hasta que alguien visitó `abogados` (3 min sin latido; el @check se perdió).
//
// Se guarda en disco la lista de namespaces vistos en la última semana y al arrancar se
// despierta cada uno (uno tras otro, sin bloquear el arranque). `/app` sobrevive al
// hot-deploy; si se pierde (caja recreada) se vuelve a lo lazy de siempre.
import fs from "node:fs";
import path from "node:path";

const FILE = process.env.TEAMS_TENANTS_FILE || (fs.existsSync("/app") ? "/app/.teams-tenants.json" : path.join(process.cwd(), ".teams-tenants.json"));
const KEEP_S = 7 * 86400;

let seen: Record<string, number> | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

function load(): Record<string, number> {
  if (seen) return seen;
  try {
    seen = JSON.parse(fs.readFileSync(FILE, "utf8")) as Record<string, number>;
  } catch {
    seen = {};
  }
  return seen;
}

/** Este proceso tocó el tenant `ns`. Escribe a disco como mucho cada 5 s. */
export function rememberTenant(ns: string): void {
  if (!ns || process.env.NODE_ENV === "test") return;
  const s = load();
  s[ns] = Math.floor(Date.now() / 1000);
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const cut = Math.floor(Date.now() / 1000) - KEEP_S;
    for (const [k, at] of Object.entries(s)) if (at < cut) delete s[k];
    try {
      fs.writeFileSync(FILE, JSON.stringify(s));
    } catch {
      /* best-effort */
    }
  }, 5_000);
  writeTimer.unref?.();
}

// namespace → slug, para que un tick tras el arranque sepa a nombre de qué espacio firma
// (`currentSlug` dentro de `withNamespace`). `warmKnownTenants` despierta por namespace y
// sin esto el slug sólo se aprendía cuando alguien visitaba el espacio: las previews y la
// tarea a Done fallaban con «sin espacio» hasta entonces (auditoría del 3-oct).
const SLUGS_FILE = FILE.replace(/\.json$/, "") + "-slugs.json";
let slugs: Record<string, string> | null = null;

function loadSlugs(): Record<string, string> {
  if (slugs) return slugs;
  try {
    slugs = JSON.parse(fs.readFileSync(SLUGS_FILE, "utf8")) as Record<string, string>;
  } catch {
    slugs = {};
  }
  return slugs;
}

/** Slug del espacio `ns` visto en una corrida anterior del proceso, o null. */
export function knownSlug(ns: string): string | null {
  if (process.env.NODE_ENV === "test") return null;
  return loadSlugs()[ns] ?? null;
}

/** Guarda `ns → slug` en disco cuando cambia (best-effort). */
export function rememberSlug(ns: string, slug: string): void {
  if (!ns || !slug || process.env.NODE_ENV === "test") return;
  const m = loadSlugs();
  if (m[ns] === slug) return;
  m[ns] = slug;
  try {
    fs.writeFileSync(SLUGS_FILE, JSON.stringify(m));
  } catch {
    /* best-effort */
  }
}

function forgetTenants(nss: string[]): void {
  const s = load();
  for (const ns of nss) delete s[ns];
  try {
    fs.writeFileSync(FILE, JSON.stringify(s));
  } catch {
    /* best-effort */
  }
}

let warmed = false;

/** Una vez por proceso: corre `ensureSchema` en cada espacio de la última semana. */
export function warmKnownTenants(): void {
  if (warmed || process.env.NODE_ENV === "test") return;
  warmed = true;
  const cut = Math.floor(Date.now() / 1000) - KEEP_S;
  const list = Object.entries(load()).filter(([, at]) => at >= cut).map(([ns]) => ns);
  if (!list.length) return;
  setTimeout(() => {
    void (async () => {
      const { withNamespace } = await import("./tenant.server");
      const { ensureSchema } = await import("./schema.server");
      // Un espacio cuyo `ensureSchema` falla entero (8-oct: 9 de 21 con «183 fallos» en cada
      // arranque) se dice cuál y por qué; si sqld ya no tiene ese namespace, se olvida en vez de
      // reintentarlo en silencio cada deploy. Si era una caída pasajera, se vuelve a recordar en
      // cuanto alguien lo visite (`rememberTenant`).
      const dead: string[] = [];
      for (const ns of list) {
        await withNamespace(ns, () => ensureSchema()).catch((e) => {
          // Sólo se olvida si sqld dice que el namespace no existe; una caída pasajera no.
          if (/namespace|not found|does not exist|404/i.test(String(e instanceof Error ? e.message : e))) dead.push(ns);
          console.warn(`[tenants] ${ns} no despertó: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`);
        });
      }
      if (dead.length) forgetTenants(dead);
      console.log(`[tenants] desperté ${list.length - dead.length} espacio(s) al arrancar${dead.length ? ` · olvidé ${dead.length}` : ""}`);
    })();
  }, 3_000).unref?.();
}
