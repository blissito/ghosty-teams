// Smoke con ACCIÓN sobre la preview del PR (16-oct, #96 de Deník). El de @check eran 33 GET
// contra localhost («0 diferencias») y lo que se rompió fueron los POST: React Router 8 compara
// el origen con protocolo y, detrás del proxy TLS, toda acción daba 400. Aquí se hace lo que
// Checkly/Playwright hacen con las previews de Vercel: la URL pública https (mismo tipo de proxy
// que prod), con el `Origin` real del navegador y un POST.
//
// El POST no escribe nada: en React Router el chequeo de origen corre ANTES de la acción, así
// que un cuerpo vacío basta. 400/403 = la petición se rechazó por origen o CSRF; 5xx = la app
// truena; 2xx/3xx, 404/405 (sin acción) o 422 (validación) = el chequeo pasó.

// method "GET" sólo aparece cuando la página misma truena (smoke de gs): sin eso, una ruta declarada que da 500 pasaría en blanco.
export type SmokeResult = { path: string; method: "GET" | "POST"; status: number | null; ok: boolean; why: string };

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
export function previewAuth(previewUrl: string): { origin: string; cookie: string | null } {
  const u = new URL(previewUrl);
  const k = u.searchParams.get("k");
  return { origin: u.origin, cookie: k ? `gs_preview=${k}` : null };
}

/** Cómo sale cada petición. `url` = a dónde llegó tras redirecciones (el GET de prod las sigue). */
export type SmokeHit = (
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number | null; body: string; url?: string }>;

/** La preview es nuestra (`*.preview.ghosty.page`): fetch directo, sin seguir saltos. */
const directHit: SmokeHit = async (url, init) => {
  const res = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!res) return { status: null, body: "" };
  return { status: res.status, body: await res.text().catch(() => "") };
};

/** Producción es una URL del dueño: pasa por el guard anti-SSRF de los monitores. */
export const guardedHit: SmokeHit = async (url, init) => {
  const { guardedRequest } = await import("../connectors/net-guard.server");
  return guardedRequest(url, { ...init, timeoutMs: 20_000 }).catch(() => ({ status: null, body: "" }));
};

/**
 * Un POST por ruta contra la preview (o contra producción, con `guardedHit` y sin `?k=`). `paths` = las de `smoke:` en `.ghosty/factory.md`; sin
 * declarar, `/`. Sólo apps de React Router (la página trae su contexto) o rutas declaradas: a una
 * app desconocida no se le manda un POST a ciegas. null = no hubo nada que probar.
 */
export async function actionSmoke(previewUrl: string, paths: string[], hit: SmokeHit = directHit): Promise<SmokeResult[] | null> {
  const auth = previewAuth(previewUrl);
  const cookie = auth.cookie;
  const declared = paths.length > 0;
  const out: SmokeResult[] = [];
  for (const path of declared ? paths : ["/"]) {
    const page = await hit(auth.origin + path, { headers: cookie ? { cookie } : {} });
    // `denik.me` → `https://www.denik.me/`: el envío va al origen donde de verdad vive la app.
    const origin = page.url ? new URL(page.url).origin : auth.origin;
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

/** Un paso del smoke de gs (`POST /api/v2/partners/smoke`). */
export type GsSmokeStep = { method: "GET" | "POST"; path: string; status: number | null; ok: boolean; why: string };

/**
 * Los pasos de gs al contrato de siempre: todos los POST y, de los GET, sólo los que fallan (gs no manda el POST
 * si la página truena, y esa falla no se puede perder). null = no hubo nada que probar, igual que `actionSmoke`.
 */
export function smokeResultsFromGs(steps: GsSmokeStep[]): SmokeResult[] | null {
  const out = steps
    .filter((s) => s.method === "POST" || !s.ok)
    .map((s): SmokeResult => ({ path: s.path, method: s.method, status: s.status, ok: s.ok, why: s.why }));
  return out.length ? out : null;
}

/** Una sola pieza de smoke (21-nov): lo corre gs. undefined = gs no contestó y toca el local. */
async function gsSmoke(previewUrl: string, paths: string[]): Promise<SmokeResult[] | null | undefined> {
  try {
    const { nativeRuntimeBase, partnerHeaders } = await import("../ghosty-runtime.server");
    const base = await nativeRuntimeBase();
    if (!base) return undefined;
    const { currentNamespace } = await import("../tenant.server");
    const body = JSON.stringify({ previewUrl, paths });
    const res = await fetch(`${base}/api/v2/partners/smoke`, { method: "POST", headers: partnerHeaders(body, await currentNamespace()), body, signal: AbortSignal.timeout(90_000) });
    if (!res.ok) throw new Error(`gs respondió ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    const data = (await res.json()) as { steps?: GsSmokeStep[] };
    if (!Array.isArray(data.steps)) throw new Error("gs no mandó steps");
    return smokeResultsFromGs(data.steps);
  } catch (e) {
    console.warn(`[factory] smoke por gs ${previewUrl}: ${(e as Error).message} (corre el local)`);
    return undefined;
  }
}

// ── Reporte completo (22-nov): página y Lighthouse, también de gs ────────────────────────────────

/** Lo que gs vio en la página (`PageSignals` de gs): imágenes rotas, desbordes y contraste, con dónde. */
export type SmokePageIssue = { kind: "image" | "layout" | "contrast"; what: string; where: string };
export type SmokePage = { brokenImages: number; layout: number; contrastFails: number; contrastRan: boolean; issues?: SmokePageIssue[] };
export type SmokeLighthouse = { performance: number | null; accessibility: number | null; bestPractices: number | null; seo: number | null } | null;
export type SmokeReport = { results: SmokeResult[] | null; page: SmokePage | null; lighthouse: SmokeLighthouse };

/** Lo de la página que se le pide arreglar al escritor, un renglón por hallazgo (puro). Contraste sólo si corrió. */
export function pageIssuesText(page: SmokePage | null, max = 8): string {
  const issues = (page?.issues ?? []).filter((i) => i.kind !== "contrast" || page?.contrastRan);
  const label = { image: "imagen rota", layout: "desborde", contrast: "contraste" } as const;
  return issues.slice(0, max).map((i) => `- ${label[i.kind]}: ${i.what}${i.where ? ` (${i.where})` : ""}`).join("\n");
}

/** Normaliza lo que manda gs (puro): números o null, issues acotadas. */
export function reportFromGs(data: { steps?: GsSmokeStep[]; page?: any; lighthouse?: any }): SmokeReport {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);
  const p = data.page;
  const page: SmokePage | null = p
    ? {
        brokenImages: Number(p.brokenImages) || 0,
        layout: Number(p.layout) || 0,
        contrastFails: Number(p.contrastFails) || 0,
        contrastRan: p.contrastRan === true,
        issues: Array.isArray(p.issues)
          ? p.issues.slice(0, 15).map((i: any) => ({ kind: i.kind, what: String(i.what ?? "").slice(0, 200), where: String(i.where ?? "").slice(0, 120) }))
          : [],
      }
    : null;
  const l = data.lighthouse;
  const lighthouse = l ? { performance: n(l.performance), accessibility: n(l.accessibility), bestPractices: n(l.bestPractices), seo: n(l.seo) } : null;
  return { results: smokeResultsFromGs(Array.isArray(data.steps) ? data.steps : []), page, lighthouse };
}

/**
 * El smoke completo de una preview, por gs (una sola pieza): rutas, página y Lighthouse. Si gs no contesta, sólo las
 * rutas con el local (sin página ni Lighthouse). Nunca lanza.
 */
export async function runSmokeReport(previewUrl: string, repo: string | null, sub: string): Promise<SmokeReport> {
  let paths: string[] = [];
  try {
    if (repo) {
      const { repoTeamFile } = await import("./factory-team.server");
      paths = (await repoTeamFile(repo, sub).catch(() => null))?.smoke ?? [];
    }
    const { nativeRuntimeBase, partnerHeaders } = await import("../ghosty-runtime.server");
    const base = await nativeRuntimeBase();
    if (base) {
      const { currentNamespace } = await import("../tenant.server");
      const body = JSON.stringify({ previewUrl, paths, full: true });
      // Inspect + Lighthouse en render-svc: hasta ~3 min.
      const res = await fetch(`${base}/api/v2/partners/smoke`, { method: "POST", headers: partnerHeaders(body, await currentNamespace()), body, signal: AbortSignal.timeout(200_000) });
      if (res.ok) return reportFromGs(await res.json());
      console.warn(`[factory] smoke completo por gs ${previewUrl}: ${res.status}`);
    }
  } catch (e) {
    console.warn(`[factory] smoke completo por gs ${previewUrl}: ${(e as Error).message}`);
  }
  return { results: await actionSmoke(previewUrl, paths).catch(() => null), page: null, lighthouse: null };
}

/** El smoke del pedido con las rutas que declara el repo. Nunca lanza: null si no se pudo correr. */
export async function runActionSmoke(previewUrl: string, repo: string | null, sub: string, hit?: SmokeHit): Promise<SmokeResult[] | null> {
  try {
    let paths: string[] = [];
    if (repo) {
      const { repoTeamFile } = await import("./factory-team.server");
      paths = (await repoTeamFile(repo, sub).catch(() => null))?.smoke ?? [];
    }
    // Las previews las prueba gs; producción (`hit` propio, p. ej. `guardedHit`) y gs caído se quedan aquí.
    if (!hit) {
      const viaGs = await gsSmoke(previewUrl, paths);
      if (viaGs !== undefined) return viaGs;
    }
    return await actionSmoke(previewUrl, paths, hit);
  } catch (e) {
    console.warn(`[factory] smoke ${previewUrl}: ${(e as Error).message}`);
    return null;
  }
}

/** Los que fallaron, en una línea por ruta, para el error a @check o el aviso del hilo. */
export function smokeFailures(r: SmokeResult[] | null): string {
  return (r ?? []).filter((x) => !x.ok).map((x) => `${x.method} ${x.path} → ${x.why}`).join("\n");
}
