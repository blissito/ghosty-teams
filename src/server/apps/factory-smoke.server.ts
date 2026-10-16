// Smoke con ACCIÓN sobre la preview del PR (16-oct, #96 de Deník). El de @check eran 33 GET
// contra localhost («0 diferencias») y lo que se rompió fueron los POST: React Router 8 compara
// el origen con protocolo y, detrás del proxy TLS, toda acción daba 400. Aquí se hace lo que
// Checkly/Playwright hacen con las previews de Vercel: la URL pública https (mismo tipo de proxy
// que prod), con el `Origin` real del navegador y un POST.
//
// El POST no escribe nada: en React Router el chequeo de origen corre ANTES de la acción, así
// que un cuerpo vacío basta. 400/403 = la petición se rechazó por origen o CSRF; 5xx = la app
// truena; 2xx/3xx, 404/405 (sin acción) o 422 (validación) = el chequeo pasó.

export type SmokeResult = { path: string; method: "POST"; status: number | null; ok: boolean; why: string };

/** Veredicto de una respuesta (puro, con su test). */
export function actionSmokeVerdict(status: number | null, body: string): { ok: boolean; why: string } {
  const excerpt = body.replace(/\s+/g, " ").trim().slice(0, 160);
  if (status === null) return { ok: false, why: "no contestó (timeout o red)" };
  if (status === 400 || status === 403)
    return { ok: false, why: `${status}: la app rechazó el envío (origen/CSRF)${excerpt ? ` — «${excerpt}»` : ""}` };
  if (status >= 500) return { ok: false, why: `${status}: la app tronó al recibir el envío${excerpt ? ` — «${excerpt}»` : ""}` };
  return { ok: true, why: `${status}: el envío pasó el chequeo de origen` };
}

/** La URL de datos de React Router (single fetch) para una ruta: `/` → `/_root.data`, `/x` → `/x.data`. */
export function reactRouterDataPath(path: string): string {
  const p = path.split("?")[0].replace(/\/+$/, "");
  return p ? `${p}.data` : "/_root.data";
}

/** La llave de la preview privada (`?k=`): el router la acepta como cookie `gs_preview`. */
function previewAuth(previewUrl: string): { origin: string; cookie: string | null } {
  const u = new URL(previewUrl);
  const k = u.searchParams.get("k");
  return { origin: u.origin, cookie: k ? `gs_preview=${k}` : null };
}

async function hit(url: string, init: RequestInit): Promise<{ status: number | null; body: string }> {
  const res = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!res) return { status: null, body: "" };
  return { status: res.status, body: await res.text().catch(() => "") };
}

/**
 * Un POST por ruta contra la preview. `paths` = las de `smoke:` en `.ghosty/factory.md`; sin
 * declarar, `/`. Sólo apps de React Router (la página trae su contexto) o rutas declaradas: a una
 * app desconocida no se le manda un POST a ciegas. null = no hubo nada que probar.
 */
export async function actionSmoke(previewUrl: string, paths: string[]): Promise<SmokeResult[] | null> {
  const { origin, cookie } = previewAuth(previewUrl);
  const declared = paths.length > 0;
  const out: SmokeResult[] = [];
  for (const path of declared ? paths : ["/"]) {
    const page = await hit(origin + path, { headers: cookie ? { cookie } : {} });
    const reactRouter = /__reactRouterContext|__remixContext/.test(page.body);
    if (!reactRouter && !declared) continue;
    const target = reactRouter ? reactRouterDataPath(path) : path;
    const res = await hit(origin + target, {
      method: "POST",
      headers: { origin, "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
      body: "",
    });
    out.push({ path: target, method: "POST", status: res.status, ...actionSmokeVerdict(res.status, res.body) });
  }
  return out.length ? out : null;
}

/** El smoke del pedido con las rutas que declara el repo. Nunca lanza: null si no se pudo correr. */
export async function runActionSmoke(previewUrl: string, repo: string | null, sub: string): Promise<SmokeResult[] | null> {
  try {
    let paths: string[] = [];
    if (repo) {
      const { repoTeamFile } = await import("./factory-team.server");
      paths = (await repoTeamFile(repo, sub).catch(() => null))?.smoke ?? [];
    }
    return await actionSmoke(previewUrl, paths);
  } catch (e) {
    console.warn(`[factory] smoke ${previewUrl}: ${(e as Error).message}`);
    return null;
  }
}

/** Los que fallaron, en una línea por ruta, para el error a @check o el aviso del hilo. */
export function smokeFailures(r: SmokeResult[] | null): string {
  return (r ?? []).filter((x) => !x.ok).map((x) => `${x.method} ${x.path} → ${x.why}`).join("\n");
}
