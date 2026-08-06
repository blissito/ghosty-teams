import { createServerFn } from "@tanstack/react-start";
import { sessionUser } from "./chat";

// Server functions del framework de conectores per-user (Cowork). El browser NUNCA ve
// los tokens: el server los guarda en gc_user_connectors y el panel solo ve estado.
// Rutas OAuth genéricas: setup.$provider.connect / setup.$provider.callback.

// Estado de los conectores para el panel: mergea el registro (metadata) con lo que el
// usuario ACTUAL tiene conectado. `connected` refleja gc_user_connectors.
export const listMyConnectorsFn = createServerFn({ method: "GET" }).handler(async () => {
  const me = await sessionUser();
  const { CONNECTORS } = await import("./connectors/registry");
  // ⚠️ Antes esto degradaba sin sesión (todo `connected:false`). Ya no puede: con
  // `holders` dentro, un anónimo se llevaría el padrón del workspace.
  if (!me) throw new Error("no autenticado");
  const { listConnectorProviders, listConnectorHolders, listSharedConnectors } = await import(
    "./connectors/store.server"
  );
  const [connected, holders, compartidas] = await Promise.all([
    listConnectorProviders(me.sub),
    listConnectorHolders(),
    listSharedConnectors(),
  ]);

  // Quién MÁS del equipo tiene cada conector. Se resuelve aquí y no en el cliente porque
  // `listWorkspaceUsers` ya filtra a los baneados y no expone correos.
  const { listWorkspaceUsers } = await import("../users.server");
  const gente = new Map((await listWorkspaceUsers()).map((u) => [u.sub, u]));
  const { listHooks } = await import("./hooks/registry.server");
  const hooks = await listHooks().catch(() => []);

  return CONNECTORS.map((c) => ({
    id: c.id,
    name: c.name,
    blurb: c.blurb,
    icon: c.icon,
    type: c.type,
    custom: !!c.custom,
    status: c.status,
    manage: c.manage ?? null,
    connected: connected.has(c.id),
    // La conexión del EQUIPO, si la hay: quién la puso y si soy yo. `mine` es lo que
    // decide si el switch se pinta como "compartir la mía" o como "es de fulano".
    shared: (() => {
      const dueño = compartidas.get(c.id);
      if (!dueño) return null;
      const u = gente.get(dueño);
      return { sub: dueño, name: u?.name ?? "", avatar: u?.avatar ?? "", mine: dueño === me.sub };
    })(),
    /** ¿Está compartida LA MÍA? Distinto de `shared`, que puede ser la de otra persona —
     *  confundirlos hacía que el botón dijera "Compartir" y creara una SEGUNDA compartida. */
    mineShared: compartidas.get(c.id) === me.sub,
    /** ¿Puedo compartir la conexión de otro? Staff y owner sí. */
    canShareOthers: !!me.isOwner,
    // Qué dejamos configurado en la cuenta del proveedor. Sin enseñarlo, nadie sabe qué
    // alertas están activas: se configuran desde el chat y desaparecen de la vista.
    hooks: hooks
      .filter((h) => h.provider === c.id)
      .map((h) => ({ project: `${h.org}/${h.project}`, channelId: h.channelId })),
    // Sin mí (ya salgo como "Conectado") y sin correo. Un sub sin fila en el padrón —
    // baneado, o alguien que nunca abrió Teams— se descarta en vez de pintarse vacío.
    holders: (holders.get(c.id) ?? [])
      .filter((s) => s !== me.sub)
      .map((s) => gente.get(s))
      .filter((u): u is NonNullable<typeof u> => !!u)
      .map((u) => ({ sub: u.sub, name: u.name, avatar: u.avatar })),
  }));
});

// Inicia el OAuth de un proveedor: setea cookies (state, y verifier PKCE si aplica) y
// devuelve el authorize URL. Lo llama el loader de setup.$provider.connect.
export const startConnectFn = createServerFn({ method: "GET" })
  .validator((d: { provider: string }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) throw new Error("no autenticado");
    const { getConnector } = await import("./connectors/registry");
    const def = getConnector(data.provider);
    if (!def?.oauth) throw new Error("proveedor no disponible");

    const { setCookie } = await import("@tanstack/react-start/server");
    const { reqOrigin } = await import("../origin.server");
    const { currentSlug } = await import("./tenant.server");
    const { randomState, pkce, buildAuthorizeUrl, callbackBase, signState } = await import("./connectors/oauth.server");
    const appUrl = await reqOrigin();
    // redirect_uri GLOBAL (apex) — el mismo registrado en el provider, no el subdominio.
    const redirectUri = `${callbackBase(appUrl)}/oauth/${def.id}/callback`;
    // El workspace de origen viaja firmado en el state → el relay del apex sabe a qué
    // subdominio volver. El nonce se liga a la cookie (validada al cerrar en el subdominio).
    const slug = await currentSlug().catch(() => null);
    const nonce = randomState();
    const state = signState({ slug, nonce });
    setCookie("conn_state", nonce, { httpOnly: true, path: "/", maxAge: 600, sameSite: "lax" });
    let challenge: string | undefined;
    if (def.oauth.pkce) {
      const p = pkce();
      setCookie("conn_pkce", p.verifier, { httpOnly: true, path: "/", maxAge: 600, sameSite: "lax" });
      challenge = p.challenge;
    }
    return { url: buildAuthorizeUrl(def, redirectUri, state, challenge) };
  });

// Relay central: el redirect global (oauth.teams.ghosty.studio/oauth/$provider/callback)
// no tiene sesión ni tenant. Verifica el state firmado, saca el workspace de origen y
// devuelve la URL del subdominio donde /setup/$provider/callback SÍ cierra el OAuth
// (con sesión + cookies + namespace). Sin slug (dev/single-tenant) → mismo origin.
export const relayConnectorFn = createServerFn({ method: "GET" })
  .validator((d: { provider: string; code: string; state: string }) => d)
  .handler(async ({ data }) => {
    const { verifyState } = await import("./connectors/oauth.server");
    const parsed = verifyState(data.state);
    const ROOT = process.env.TEAMS_ROOT_DOMAIN ?? "teams.ghosty.studio";
    const qs = `?code=${encodeURIComponent(data.code)}&state=${encodeURIComponent(data.state)}`;
    const path = `/setup/${encodeURIComponent(data.provider)}/callback${qs}`;
    return { target: parsed?.slug ? `https://${parsed.slug}.${ROOT}${path}` : path };
  });

// Cierra el OAuth: valida state (cookie), intercambia code→token, captura external_id +
// meta del userinfo, y persiste para el usuario de la sesión. Lo llama el callback.
export const finishConnectFn = createServerFn({ method: "POST" })
  .validator((d: { provider: string; code: string; state: string }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return { ok: false as const };
    const { getConnector } = await import("./connectors/registry");
    const def = getConnector(data.provider);
    if (!def?.oauth) return { ok: false as const };

    const { getCookie } = await import("@tanstack/react-start/server");
    const { exchangeCode, callbackBase, verifyState } = await import("./connectors/oauth.server");
    // Valida el state firmado y liga su nonce a la cookie del subdominio (anti-CSRF).
    const parsed = verifyState(data.state);
    if (!data.code || !parsed || parsed.nonce !== getCookie("conn_state")) return { ok: false as const };
    const verifier = def.oauth.pkce ? getCookie("conn_pkce") : undefined;

    const { reqOrigin } = await import("../origin.server");
    const { setConnectorRow } = await import("./connectors/store.server");
    const appUrl = await reqOrigin();
    // MISMO redirect_uri global que en authorize (requisito del token-exchange OAuth).
    const redirectUri = `${callbackBase(appUrl)}/oauth/${def.id}/callback`;
    const tok = await exchangeCode(def, redirectUri, data.code, verifier ?? undefined);
    const now = Math.floor(Date.now() / 1000);

    // userinfo → external_id + meta, con el parser QUE DECLARA EL CONECTOR: cada proveedor
    // devuelve una forma distinta, así que traducirla es cosa suya (registry.ts), no de aquí.
    // Best-effort: si el userinfo falla, la conexión igual queda hecha.
    let externalId: string | null = null;
    let meta: unknown = null;
    if (def.oauth.userInfoUrl && def.oauth.parseUserInfo) {
      try {
        const r = await fetch(def.oauth.userInfoUrl, { headers: { Authorization: `Bearer ${tok.access_token}` } });
        if (r.ok) {
          const parsed = def.oauth.parseUserInfo(await r.json());
          externalId = parsed.externalId;
          meta = parsed.meta;
        }
      } catch {}
    }

    await setConnectorRow({
      sub: me.sub,
      provider: def.id,
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token ?? null,
      expiresAt: tok.expires_in ? now + tok.expires_in : null,
      externalId,
      meta,
    });
    return { ok: true as const };
  });

// Desconecta un proveedor del usuario actual. El re-connect es inmediato.
//
// Además de borrar la fila, REVOCA el token contra el proveedor si éste declara
// `revokeUrl`: sin eso "Desconectar" sólo significa "dejo de usarlo", y el token
/**
 * Prende o apaga "esta conexión es del equipo".
 *
 * Puede hacerlo el dueño, y también **staff u owner** sobre la conexión de otro: es lo que
 * destraba el caso de alguien ausente —un cliente conectó su Sentry y se fue— sin pedirle
 * que reconecte. La contrapartida es que el dueño se ENTERA: aviso + bitácora. Una cuenta
 * ajena usándose por el equipo no puede quedar sin rastro de quién lo autorizó y cuándo.
 *
 * NO toca el token ni ninguna otra columna: es un UPDATE de `shared`. Dejar de compartir y
 * desconectar son cosas distintas y ésta nunca borra nada.
 */
export const shareConnectorFn = createServerFn({ method: "POST" })
  .validator((d: { provider: string; ownerSub?: string; shared: boolean }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) throw new Error("no autenticado");
    const ownerSub = data.ownerSub || me.sub;
    const ajena = ownerSub !== me.sub;
    if (ajena && !me.isOwner) throw new Error("solo staff u owner puede compartir la conexión de otro");

    const { getConnectorRow, setConnectorShared } = await import("./connectors/store.server");
    const row = await getConnectorRow(ownerSub, data.provider);
    if (!row?.access_token) throw new Error("esa persona no tiene ese conector conectado");

    await setConnectorShared(ownerSub, data.provider, data.shared);

    const { dbq } = await import("../dbq.server");
    await dbq(
      `INSERT INTO gt_connector_shares (at, actor_sub, owner_sub, provider, shared)
       VALUES (unixepoch(), ?, ?, ?, ?)`,
      [me.sub, ownerSub, data.provider, data.shared ? 1 : 0]
    ).catch((e) => console.warn("[connectors] bitácora de compartir falló:", e));

    // Sólo si lo hizo alguien más: enterarse de tu propia acción es ruido. Un único
    // destinatario, nunca el roster.
    if (ajena) {
      try {
        const { getConnector } = await import("./connectors/registry");
        const { notify } = await import("./notify.server");
        const { currentNamespace } = await import("./tenant.server");
        const nombre = getConnector(data.provider)?.name ?? data.provider;
        await notify(
          {
            kind: "mention",
            recipients: [ownerSub],
            title: data.shared ? `Tu conexión de ${nombre} ahora es del equipo` : `Tu conexión de ${nombre} ya no es del equipo`,
            body: data.shared
              ? `${me.name} la compartió con el workspace: el resto del equipo puede usarla desde el agente.`
              : `${me.name} dejó de compartirla.`,
            url: "/",
          },
          await currentNamespace()
        );
      } catch (e) {
        console.warn("[connectors] aviso de compartir falló:", e);
      }
    }
    return { ok: true, shared: data.shared };
  });

// seguiría siendo válido allá hasta expirar. Con permisos amplios eso no basta.
export const disconnectConnectorFn = createServerFn({ method: "POST" })
  .validator((d: { provider: string }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) throw new Error("no autenticado");
    const { deleteConnectorRow, getConnectorRow } = await import("./connectors/store.server");
    const { getConnector } = await import("./connectors/registry");

    // ── Limpiar lo que dejamos en la cuenta del proveedor, ANTES de revocar ──────
    // El orden es lo que hace esto posible: al revocar el token se pierde la única forma
    // de quitar los webhooks, y quedarían vivos en el Sentry del cliente publicando en un
    // canal para siempre. Lo que no se pueda limpiar se REPORTA, para que el usuario sepa
    // que le queda algo suelto en vez de descubrirlo semanas después.
    const sueltos: string[] = [];
    try {
      const { hooksOfOwner, forgetHook } = await import("./hooks/registry.server");
      const hooks = await hooksOfOwner(me.sub, data.provider);
      if (hooks.length && data.provider === "sentry") {
        const { desregistrarAlerta } = await import("./connectors/sentry.server");
        for (const h of hooks) {
          const r = await desregistrarAlerta(me.sub, h.org, h.project, h.channelId).catch(
            (e: unknown) => ({ error: String(e) })
          );
          if ((r as any)?.error) sueltos.push(`${h.org}/${h.project}`);
          else await forgetHook(h.provider, h.channelId, h.org, h.project).catch(() => {});
        }
      }
    } catch (e) {
      console.warn(`[connectors] limpieza de webhooks de ${data.provider} falló:`, e);
    }

    const def = getConnector(data.provider);
    const revokeUrl = def?.oauth?.revokeUrl;
    if (revokeUrl) {
      // Best-effort y ANTES de borrar (después ya no hay token que mandar). Que
      // el proveedor esté caído no debe impedir desconectar del lado de Teams.
      try {
        const row = await getConnectorRow(me.sub, data.provider);
        const token = row?.refresh_token || row?.access_token;
        if (token) {
          await fetch(revokeUrl, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: process.env[def!.oauth!.clientIdEnv] ?? "",
              client_secret: process.env[def!.oauth!.clientSecretEnv] ?? "",
              token,
            }),
          });
        }
      } catch (e) {
        console.warn(`[connectors] revoke de ${data.provider} falló:`, e);
      }
    }

    await deleteConnectorRow(me.sub, data.provider);
    return {
      ok: true as const,
      // Proyectos cuyas alertas NO se pudieron apagar: el usuario tiene que quitarlas a
      // mano en su Sentry, porque desde aquí ya no hay token con qué hacerlo.
      pendientesDeLimpiar: sueltos,
    };
  });

// ── Acciones directas desde una tarjeta del chat ──────────────────────────────
//
// La tarjeta de PR (`gt-pr`) no manda texto al chat como la de Sentry: llama aquí. Dos
// razones, y las dos importan:
//
//  1. Aprobar es binario e inmediato. Pasarlo por el agente cuesta un turno entero
//     (~15 s y tokens) para algo que es una llamada HTTP, y mete al modelo a decidir
//     si de verdad aprueba.
//  2. El review queda a nombre de QUIEN HACE CLIC, no de quien pidió la revisión. Eso
//     sale gratis aquí porque el `sub` viene de la SESIÓN; por el chat dependería de
//     quién resultara ser el invocador del turno.
//
// ⚠️ La lista de acciones es CERRADA. Es una server function que corre una tool de
// conector con el token del usuario: si aceptara un nombre libre, cualquiera con sesión
// podría invocar cualquier tool de cualquier conector suyo con los argumentos que
// quisiera. Sólo se permite lo que un botón de tarjeta puede disparar.
const CARD_ACTIONS: Record<string, { provider: string; tool: string }> = {
  pr_approve: { provider: "github", tool: "github_create_review" },
  pr_request_changes: { provider: "github", tool: "github_create_review" },
  // Rechazar = CERRAR el PR sin mergear. Es reversible (se puede reabrir), por eso no
  // pide confirmación extra. Va por la API de issues, que es la que cierra un PR.
  pr_reject: { provider: "github", tool: "github_update_issue" },
  // Sobre tu PROPIO PR sólo está permitido un review de tipo COMMENT. Sin esta acción la
  // tarjeta era un callejón: te decía que no podías aprobar ni pedir cambios y ahí moría.
  pr_comment: { provider: "github", tool: "github_create_review" },
  pr_merge: { provider: "github", tool: "github_merge_pr" },
};

export const runCardActionFn = createServerFn({ method: "POST" })
  .validator(
    (d: {
      action: string;
      repo: string;
      number: number;
      body?: string;
      /** Hallazgos anclados a una línea del diff — lo que hace que esto sea un review. */
      comments?: { path: string; line: number; body: string }[];
      /** Para avisar a las demás pestañas sin despertar al agente. */
      channelId?: number;
      parentId?: number;
    }) => d,
  )
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return { ok: false as const, error: "no autenticado" };

    const spec = CARD_ACTIONS[data.action];
    if (!spec) return { ok: false as const, error: "acción no permitida" };

    const repo = String(data.repo ?? "");
    const number = Number(data.number);
    if (!repo.includes("/") || !Number.isFinite(number) || number <= 0) {
      return { ok: false as const, error: "PR inválido" };
    }

    const { getConnectorRow } = await import("./connectors/store.server");
    const row = await getConnectorRow(me.sub, spec.provider);
    if (!row?.access_token) {
      // Es el caso normal en un canal: la reseña la pidió otra persona y quien mira la
      // tarjeta todavía no conectó su GitHub. Tiene que decirlo, no fallar en genérico.
      return { ok: false as const, error: "Conecta tu GitHub en Ajustes → Integraciones para poder hacer esto." };
    }

    const { loaderFor, toolsOf } = await import("./connectors/impl");
    const loader = loaderFor(spec.provider);
    if (!loader) return { ok: false as const, error: "conector no disponible" };
    const tool = (await toolsOf(await loader(), me.sub, null)).find((t) => t.name === spec.tool);
    if (!tool) return { ok: false as const, error: "acción no disponible" };

    const body = String(data.body ?? "").trim();

    if (data.action === "pr_reject") {
      const r = (await tool.handler(me.sub, { repo, number, state: "closed" })) as Record<string, unknown>;
      if (r?.error) return { ok: false as const, error: String(r.error) };
      await avisaAlCanal(data);
      return { ok: true as const, event: "CLOSED", url: typeof r?.url === "string" ? r.url : "" };
    }

    if (data.action === "pr_merge") {
      const r = (await tool.handler(me.sub, { repo, number })) as Record<string, unknown>;
      if (r?.error) return { ok: false as const, error: String(r.error) };
      await avisaAlCanal(data);
      return { ok: true as const, event: "MERGED", url: "" };
    }

    const event =
      data.action === "pr_approve" ? "APPROVE" : data.action === "pr_comment" ? "COMMENT" : "REQUEST_CHANGES";
    const comments = Array.isArray(data.comments) ? data.comments : [];
    const args: Record<string, unknown> = {
      repo,
      number,
      event,
      // GitHub exige cuerpo para REQUEST_CHANGES. El de APPROVE es opcional y se omite:
      // un "LGTM" automático firmado por una persona que quizá no leyó el diff es peor
      // que un approve escueto.
      // ⚠️ Antes iba un "Pide cambios (desde Ghosty)." fijo y el ANÁLISIS SE PERDÍA — que
      // es justo lo único que valía del turno. Ahora sube el veredicto de la tarjeta.
      ...(event !== "APPROVE" ? { body: body || "Revisión de Ghosty." } : {}),
      ...(comments.length ? { comments } : {}),
    };
    let r = (await tool.handler(me.sub, args)) as Record<string, unknown>;

    // ⚠️ Red obligatoria. GitHub tumba el review ENTERO con un 422 si UNA sola línea cae
    // fuera del diff, y el modelo se equivoca de línea con facilidad. Perder el análisis
    // por eso sería lo peor de los dos mundos: se reintenta sin anclar, con todo en el
    // cuerpo, y se avisa de que quedó plano.
    let degradado = false;
    if (r?.error && comments.length && /422|line|diff/i.test(String(r.error))) {
      degradado = true;
      const plano = comments.map((c) => `- \`${c.path}:${c.line}\` — ${c.body}`).join("\n");
      const { comments: _fuera, ...sinAnclar } = args;
      r = (await tool.handler(me.sub, {
        ...sinAnclar,
        body: [body, plano].filter(Boolean).join("\n\n"),
      })) as Record<string, unknown>;
    }

    if (r?.error) {
      // El error crudo de GitHub llegaba a la tarjeta como un volcado de JSON.
      const txt = String(r.error);
      const propio = /own pull request/i.test(txt);
      return {
        ok: false as const,
        error: propio
          ? "GitHub no deja aprobar ni pedir cambios en tu propio PR. Que lo revise alguien más del equipo."
          : txt.replace(/\{.*\}/s, "").trim() || txt,
      };
    }
    await avisaAlCanal(data);
    // El usuario tiene derecho a saber que sus comentarios NO quedaron junto al código.
    return { ok: true as const, event, url: typeof r?.url === "string" ? r.url : "", degradado };
  });

/**
 * Avisa a las demás pestañas de que este PR cambió, SIN despertar al agente.
 *
 * ⚠️ La primera versión lo anunciaba mandando un mensaje al chat, y eso disparaba un turno
 * entero por un clic. `refresh` sólo lleva ids y el cliente revalida: sin sonido, sin badge
 * y sin insertar mensaje — la misma regla que documenta `forms/ficha.server.ts`
 * ("`refresh` y NUNCA `message:new`").
 */
async function avisaAlCanal(data: { channelId?: number; parentId?: number }): Promise<void> {
  if (!data.channelId) return;
  try {
    const { publish, ch } = await import("./bus.server");
    const { currentNamespace } = await import("./tenant.server");
    publish(ch.room(await currentNamespace(), data.channelId), {
      t: "refresh",
      channelId: data.channelId,
      parentId: data.parentId ?? null,
      dmId: null,
    });
  } catch {
    // Que el aviso falle no puede tumbar una acción que YA se ejecutó en GitHub.
  }
}

/**
 * Estado ACTUAL de un PR para la tarjeta: abierto/cerrado/mergeado y quién lo revisó.
 *
 * ⚠️ Existe porque la primera versión anunciaba la acción **mandando un mensaje al chat**,
 * y eso tenía dos fallos: despertaba al agente —un turno entero por un clic, justo lo que
 * la acción directa venía a evitar— y el ✓ del botón sólo lo veía quien hizo clic.
 *
 * La verdad de quién aprobó vive en GitHub, no en nuestra base. Preguntársela es correcto
 * incluso cuando alguien actúa desde github.com sin pasar por la tarjeta, y no necesita
 * tabla nueva ni sincronización.
 */
export const prCardStateFn = createServerFn({ method: "POST" })
  .validator((d: { repo: string; number: number }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return null;
    const repo = String(data.repo ?? "");
    const number = Number(data.number);
    if (!repo.includes("/") || !Number.isFinite(number) || number <= 0) return null;

    const { getValidToken } = await import("./connectors/oauth.server");
    const token = await getValidToken(me.sub, "github");
    // Sin conexión propia no se pinta estado ni se ofrecen botones: no es un error, es que
    // esta persona todavía no conectó su GitHub.
    if (!token) return { connected: false as const };

    const h = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    const get = (p: string) =>
      fetch(`https://api.github.com/repos/${repo}${p}`, { headers: h })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);

    const [pr, reviews] = await Promise.all([get(`/pulls/${number}`), get(`/pulls/${number}/reviews`)]);
    if (!pr) return { connected: true as const, unknown: true as const };

    // ⚠️ GitHub no deja aprobar tu PROPIO pull request, y no hay ajuste que lo cambie.
    // Ofrecer el botón a quien lo abrió sólo sirve para que el clic falle: se oculta y se
    // dice por qué. Pasa cuando el PR se abrió antes de encender la identidad de bot, o
    // cuando lo abrió la persona a mano.
    const { getConnectorRow } = await import("./connectors/store.server");
    const row = await getConnectorRow(me.sub, "github");
    let miLogin = "";
    try { miLogin = JSON.parse(row?.meta ?? "{}")?.login ?? ""; } catch { /* meta corrupto: se trata como si no fuera el autor */ }
    const soyElAutor = !!miLogin && miLogin === String(pr.user?.login ?? "");

    // El ÚLTIMO veredicto de cada persona: GitHub guarda todos los reviews, y quedarse con
    // el primero enseñaría "cambios pedidos" de alguien que ya aprobó después.
    const last = new Map<string, string>();
    for (const r of Array.isArray(reviews) ? reviews : []) {
      const st = String(r?.state ?? "");
      if (st === "APPROVED" || st === "CHANGES_REQUESTED") last.set(String(r?.user?.login ?? ""), st);
    }
    const approvers = [...last].filter(([, s]) => s === "APPROVED").map(([u]) => u);
    const blockers = [...last].filter(([, s]) => s === "CHANGES_REQUESTED").map(([u]) => u);

    return {
      connected: true as const,
      state: pr.merged ? "merged" : (String(pr.state) as "open" | "closed"),
      approvers,
      blockers,
      // Sólo con el PR abierto tienen sentido los botones.
      actionable: !pr.merged && pr.state === "open",
      soyElAutor,
    };
  });

/* ── Tarjeta de TAREA ─────────────────────────────────────────────────────── */

/**
 * Acciones de la tarjeta de tarea. Gemela de `CARD_ACTIONS`, y **igual de cerrada**: esto
 * corre una acción de tablero con la cuenta de quien hace clic, así que un nombre libre
 * dejaría a cualquiera con sesión ejecutar lo que quisiera sobre el tablero.
 */
const TASK_CARD_ACTIONS = new Set(["task_done", "task_assign_me"]);

export const runTaskCardActionFn = createServerFn({ method: "POST" })
  .validator((d: { action: string; id: number; channelId?: number; parentId?: number }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return { ok: false as const, error: "no autenticado" };
    if (!TASK_CARD_ACTIONS.has(data.action)) return { ok: false as const, error: "acción no permitida" };
    const id = Number(data.id);
    if (!Number.isFinite(id) || id <= 0) return { ok: false as const, error: "tarea inválida" };

    const { resolveBoard } = await import("./tasks-boards.server");
    const { callTasks } = await import("./tasks-bridge.server");
    const { currentSlug } = await import("./tenant.server");
    const slug = await currentSlug();
    if (!slug) return { ok: false as const, error: "no pude resolver el espacio de trabajo" };

    // El tablero sale del ROOM, nunca del cliente: si viniera en el body, cualquiera con
    // sesión podría dirigir la acción al tablero de otro equipo.
    const pick = await resolveBoard(data.channelId ?? null);
    if (pick.kind !== "board") return { ok: false as const, error: "este room no tiene un tablero asignado" };

    const r =
      data.action === "task_done"
        ? await callTasks(slug, me.sub, pick.board.id, "task_move", { id, column: "Done" })
        : await callTasks(slug, me.sub, pick.board.id, "task_update", { id, assignee: "yo" });
    if (!r.ok) return { ok: false as const, error: r.error };
    await avisaAlCanal(data);
    return { ok: true as const, action: data.action };
  });

/**
 * Estado ACTUAL de una tarea para la tarjeta.
 *
 * ⚠️ No se guarda en el mensaje: si alguien la mueve desde el tablero, una tarjeta que
 * recordara su columna seguiría diciendo "En curso" para siempre. Es la misma lección que
 * el `localStorage` de la primera versión de la tarjeta de PR.
 */
export const taskCardStateFn = createServerFn({ method: "POST" })
  .validator((d: { id: number; channelId?: number }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return null;
    const id = Number(data.id);
    if (!Number.isFinite(id) || id <= 0) return null;

    const { resolveBoard, boardUrl } = await import("./tasks-boards.server");
    const { callTasks } = await import("./tasks-bridge.server");
    const { currentSlug } = await import("./tenant.server");
    const slug = await currentSlug();
    if (!slug) return null;
    const pick = await resolveBoard(data.channelId ?? null);
    if (pick.kind !== "board") return null;

    // No hay un `get_task`: se busca en el tablero, que es una sola llamada y además trae
    // el nombre de la columna ya resuelto.
    const r = await callTasks(slug, me.sub, pick.board.id, "task_board_read", {});
    if (!r.ok) return null;
    const board = r.result as any;
    const cols: any[] = board?.columns ?? [];
    for (const c of cols) {
      const t = (c?.tasks ?? []).find((x: any) => Number(x?.id) === id);
      if (!t) continue;
      const column = String(c?.name ?? "");
      return {
        column,
        assignee: String(t?.assignee ?? t?.assignee_sub ?? ""),
        // "Done" por NOMBRE es lo mismo que hace `move_task` del otro lado. Un tablero con
        // la columna renombrada no se marcaría como cerrado — es la contrapartida conocida
        // de no tener un flag de "columna final" en el esquema.
        done: column.toLowerCase() === "done",
        board: pick.board.name,
        url: boardUrl(slug, pick.board.slug, id),
      };
    }
    return null;
  });
