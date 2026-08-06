import { createServerFn } from "@tanstack/react-start";

// Guard de tenant: ¿el subdominio de este request resuelve a un workspace vivo?
// Si es un workspace borrado/desconocido → {ok:false} + portal para redirigir (en
// vez de pintar un shell roto o el label fantasma del workspace muerto). Apex/dev
// (sin subdominio de workspace) → {ok:true} (no aplica el guard).
export const tenantStatusFn = createServerFn({ method: "GET" }).handler(async () => {
  const IDP = process.env.GHOSTY_IDENTITY_URL ?? "https://www.ghosty.studio";
  const { currentSlug, currentNamespace } = await import("./tenant.server");
  const slug = await currentSlug();
  if (!slug) return { ok: true as const, portal: IDP };
  try {
    await currentNamespace(); // lanza si el slug 404ea en el resolver de gs
    return { ok: true as const, portal: IDP };
  } catch {
    return { ok: false as const, portal: IDP };
  }
});

// Multi-workspace: lista los workspaces de los que el usuario de la sesión es
// miembro (para el switcher del sidebar). La verdad vive en el control-plane
// (ghosty.studio) — aquí solo consultamos firmado (GHOSTY_PARTNER_SECRET, HMAC
// ts.sub) y devolvemos los datos mínimos para pintar y saltar de subdominio.
//
// Importa dbq/tenant SOLO dinámico (lo consume el cliente por su server fn →
// import-protection prohíbe estáticos *.server.* en el bundle cliente).
export const listMyWorkspacesFn = createServerFn({ method: "GET" }).handler(async () => {
  const { useSession } = await import("@tanstack/react-start/server");
  const { sessionConfig } = await import("./session.server");
  const s = await useSession<{ user?: { sub: string } }>(sessionConfig());
  const sub = s.data.user?.sub;

  const IDP = process.env.GHOSTY_IDENTITY_URL ?? "https://www.ghosty.studio";
  const ROOT = process.env.TEAMS_ROOT_DOMAIN ?? "teams.ghosty.studio";

  const { currentSlug } = await import("./tenant.server");
  const current = await currentSlug();

  // Base para "volver a Ghosty Studio" / "nuevo workspace" (el portal del ecosistema).
  const empty = { current, portal: IDP, workspaces: [] as Array<{ slug: string; role: string; url: string }> };
  if (!sub) return empty;

  try {
    const crypto = await import("node:crypto");
    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto
      .createHmac("sha256", process.env.GHOSTY_PARTNER_SECRET!)
      .update(`${ts}.${sub}`)
      .digest("hex");
    const res = await fetch(
      `${IDP}/internal/user-workspaces?sub=${encodeURIComponent(sub)}&ts=${ts}&sig=${sig}`
    );
    if (!res.ok) return empty;
    const j = (await res.json()) as { workspaces?: Array<{ slug: string; role: string }> };
    const workspaces = (j.workspaces ?? []).map((w) => ({
      slug: w.slug,
      role: w.role,
      url: `https://${w.slug}.${ROOT}`,
    }));
    return { current, portal: IDP, workspaces };
  } catch {
    return empty;
  }
});

// Consumo de tokens del workspace en el mes en curso, para el tab "Uso" de Ajustes.
// La verdad vive en el control-plane (ghosty.studio), igual que el plan: gs es quien
// recibe los reportes del worker y quien sabe cuántos tokens incluye el paquete. Aquí
// no se guarda nada ni se calcula ningún tope — duplicarlo sería tener dos cifras que
// se contradicen.
//
// Devuelve null si algo falla o si el workspace no tiene consumo medible: el tab
// prefiere no pintar barra a pintar un cero que parece un bug.
export const workspaceUsageFn = createServerFn({ method: "GET" }).handler(async () => {
  const IDP = process.env.GHOSTY_IDENTITY_URL ?? "https://www.ghosty.studio";
  const { currentSlug } = await import("./tenant.server");
  const slug = await currentSlug();
  if (!slug) return null;

  try {
    const crypto = await import("node:crypto");
    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto
      .createHmac("sha256", process.env.GHOSTY_PARTNER_SECRET!)
      .update(`${ts}.${slug}`)
      .digest("hex");
    const res = await fetch(`${IDP}/internal/workspace-usage/${encodeURIComponent(slug)}?ts=${ts}&sig=${sig}`);
    if (!res.ok) return null;
    const raw = (await res.json()) as {
      plan: string;
      combo: string;
      paidUntil: string | null;
      resetsAt: string;
      used: number;
      included: number;
      turns: number;
      messagesUsed: number;
      messagesIncluded: number;
      /** UNA BOLSA POR MOTOR. `included:null` = ilimitado, porque ese agente corre con la
       *  llave del cliente: es su saldo con el proveedor, no el nuestro. Se mide y se
       *  enseña; no se corta. */
      engines?: { engine: string; used: number; included: number | null; turns: number; ownKey: boolean; agentId?: string | null; agentName?: string | null; name?: string; avatar?: string; handle?: string }[];
    };

    // Ponerle CARA a cada renglón. El cruce hace falta porque el dato está partido: sólo
    // Teams sabe qué agente está activado aquí y cómo se llama; sólo Studio sabe cuánto
    // gastó cada uno.
    //
    // ⚠️ Se cruza por `agentId` (el fleetAgentId, que los dos lados conocen) y NO por
    // motor. Cruzar por motor tomaba el PRIMER agente que lo usara, así que dos agentes
    // Claude salían los dos rotulados como el primero y el segundo no aparecía nunca.
    //
    // Un renglón que no resuelve a ningún agente activado aquí conserva su etiqueta
    // genérica si tiene consumo —desaparecer un gasto real es peor que enseñar
    // "deepseek"— pero se DESCARTA si está en cero: es un agente de Studio que este
    // espacio no tiene activado, y pintarlo era inventar un compañero que no existe.
    if (raw.engines?.length) {
      try {
        const { resolvedAgents, engineOfAgent } = await import("../agents.server");
        const agentes = await resolvedAgents();
        const conCara = await Promise.all(
          agentes.map(async (a) => ({ a, engine: await engineOfAgent(a) })),
        );
        const porId = new Map(
          conCara.filter((x) => x.a.backend.kind === "fleet").map((x) => [(x.a.backend as { id: string }).id, x.a]),
        );
        raw.engines = raw.engines
          .map((e) => {
            // Sin `agentId` (filas anteriores a 2026-08-06, agrupadas por motor) queda el
            // cruce viejo: ambiguo, pero es todo lo que se sabe de ellas.
            const a = e.agentId ? porId.get(e.agentId) : conCara.find((x) => x.engine === e.engine)?.a;
            return a
              ? { ...e, name: a.name, avatar: a.avatar, handle: a.handle }
              : { ...e, name: e.agentName ?? undefined };
          })
          .filter((e) => e.handle || e.used > 0);
      } catch {
        // Sin nombres se pinta con la etiqueta del motor. El consumo es el dato; la cara
        // es el adorno, y no vale perder el primero por el segundo.
      }
    }
    return raw;
  } catch {
    return null;
  }
});
