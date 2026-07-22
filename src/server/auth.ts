import { createServerFn } from "@tanstack/react-start";

// Sesión + login con Ghosty.studio (IdP del ecosistema). ghosty.studio = quién eres;
// EasyBits = recursos. (Antes esto era Formmy — ya NO dependemos de Formmy para identidad.)
const IDP = process.env.GHOSTY_IDENTITY_URL ?? "https://www.ghosty.studio";

async function session() {
  const { useSession } = await import("@tanstack/react-start/server");
  const { sessionConfig } = await import("./session.server");
  return useSession<{ user?: import("../users.server").SessionUser }>(sessionConfig());
}

export const me = createServerFn({ method: "GET" }).handler(async () => {
  const s = await session();
  return s.data.user ?? null;
});

// Identidad cacheada para el CLIENTE. `me()` es un server fn (round-trip a la
// cookie) y __root.beforeLoad lo corre en CADA navegación (defaultStaleTime 5s);
// sin cache, volver de /settings esperaba la red antes de pintar → se sentía como
// recarga total (rooms/hilos "recargando"). Cacheamos el primer resultado y
// revalidamos en background: las navegaciones siguientes resuelven instantáneo y
// la sesión se refresca en silencio. En SSR siempre va fresco (sin cache).
type Me = Awaited<ReturnType<typeof me>>;
let _meCache: Me | undefined; // undefined = aún sin resolver; null = sin sesión
export async function cachedMe(): Promise<Me> {
  if (typeof window === "undefined") return me();
  if (_meCache !== undefined) {
    me().then((u) => { _meCache = u; }).catch(() => {});
    return _meCache;
  }
  _meCache = await me();
  return _meCache;
}
// Lectura SÍNCRONA de la identidad ya cacheada (sin round-trip). `undefined` = aún
// sin resolver; `null` = sin sesión; objeto = user. __root.beforeLoad corre `cachedMe`
// en cada nav, así que en el cliente casi siempre está poblado → permite pintar al
// instante (ej. Preferencias) sin esperar la red.
export function peekMe(): Me | undefined {
  return _meCache;
}

// Al hacer logout hay que invalidar la cache o una nav protegida vería al usuario
// viejo (el guard no redirigiría) hasta la siguiente revalidación.
export function clearMeCache() {
  _meCache = undefined;
}

// Devuelve el URL firmado del handshake de identidad de ghosty.studio (firma
// box→IdP). El IdP verifica `ts.origin` con GHOSTY_PARTNER_SECRET y, si hay sesión
// gs, regresa por 302 a `<origin><return>?payload&sig`.
export const startGhostyLogin = createServerFn({ method: "GET" })
  .validator((d: { inviteToken?: string } | undefined) => d ?? {})
  .handler(async ({ data }) => {
    const crypto = await import("node:crypto");
    // El origin se deriva del request (cada workspace tiene su subdominio) —
    // multitenant, sin env fijo. El ingress pone x-ghosty-origin (dominio estable);
    // detrás del proxy el host público va en x-forwarded-*. APP_URL solo override.
    let origin = process.env.APP_URL ?? "";
    if (!origin) {
      const { getRequestHeader, getRequestHost, getRequestProtocol } = await import(
        "@tanstack/react-start/server"
      );
      // 1) x-ghosty-origin: lo pone el ingress (Caddy) → origin = dominio estable.
      // 2) x-forwarded-host: acceso directo al sb-xxx. 3) Host crudo como último recurso.
      const ghostyOrigin = getRequestHeader("x-ghosty-origin");
      if (ghostyOrigin) {
        origin = ghostyOrigin;
      } else {
        const host = getRequestHeader("x-forwarded-host") || getRequestHost();
        const proto = getRequestHeader("x-forwarded-proto") || getRequestProtocol() || "https";
        if (host) origin = `${proto}://${host}`;
      }
    }
    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto
      .createHmac("sha256", process.env.GHOSTY_PARTNER_SECRET!)
      .update(`${ts}.${origin}`)
      .digest("hex");
    const p = new URLSearchParams({ ts: String(ts), sig, o: origin });
    return { url: `${IDP}/identity/connect?${p}`, idpOrigin: IDP, inviteToken: data.inviteToken };
  });

// Recibe la identidad firmada por ghosty.studio (firma IdP→box), crea sesión.
export const completeGhostyLogin = createServerFn({ method: "POST" })
  .validator((d: { payload: string; sig: string; inviteToken?: string }) => d)
  .handler(async ({ data }) => {
    const crypto = await import("node:crypto");
    const secret = process.env.GHOSTY_PARTNER_SECRET!;
    const expected = crypto.createHmac("sha256", secret).update(data.payload).digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(data.sig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error("firma inválida");
    const id = JSON.parse(Buffer.from(data.payload, "base64url").toString()) as {
      sub: string; email: string; name: string; avatar: string; ts: number;
    };
    if (Math.abs(Math.floor(Date.now() / 1000) - id.ts) > 300) throw new Error("identidad expirada");

    const { consumeInvite } = await import("./invites");
    // Si trae invite, valídalo (member). Sin invite solo entra si ya hay owner
    // (o es el primer login = owner).
    const invited = data.inviteToken ? await consumeInvite(data.inviteToken, id.sub) : false;

    // Expulsado del workspace → rebota (aunque tenga identidad IdP válida). Antes del
    // upsert para no re-crearlo/tocarlo.
    const { isBanned } = await import("../users.server");
    if (await isBanned(id.sub)) throw new Error("sin acceso a este workspace");

    const { upsertUser } = await import("../users.server");
    const user = await upsertUser({ sub: id.sub, email: id.email, name: id.name, avatar: id.avatar });

    // Forward-compat: si se unió por invite, registra `Membership(MEMBER)` en gs
    // (fuente única de verdad de membership+rol). Así el switcher multi-workspace
    // muestra el ws al invitado y la futura UI de roles solo hace UPDATE. Best-effort:
    // no bloquea el login si gs falla (se reconcilia luego).
    if (invited) {
      try {
        await registerMembership(id.sub);
      } catch (e) {
        console.warn("[auth] registerMembership falló (best-effort):", (e as Error)?.message);
      }
    }

    // Un no-owner sin invitación no puede entrar (solo el owner y los invitados).
    if (!user.isOwner && !invited) {
      const { isKnownUser } = await import("./invites");
      if (!(await isKnownUser(id.sub))) throw new Error("necesitas una invitación");
    }

    const s = await session();
    await s.update({ user });
    return { ok: true as const, user };
  });

// Registra Membership(MEMBER) del invitado en gs (control-plane), firmado HMAC
// `ts.sub.slug`. El slug sale del subdominio del request (tenant.server). En apex/dev
// sin subdominio no hay workspace que registrar → no-op.
async function registerMembership(sub: string): Promise<void> {
  const { currentSlug } = await import("./tenant.server");
  const slug = await currentSlug();
  if (!slug) return;
  const crypto = await import("node:crypto");
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto
    .createHmac("sha256", process.env.GHOSTY_PARTNER_SECRET!)
    .update(`${ts}.${sub}.${slug}`)
    .digest("hex");
  const p = new URLSearchParams({ sub, slug, ts: String(ts), sig });
  const res = await fetch(`${IDP}/internal/memberships?${p}`, { method: "POST" });
  if (!res.ok) throw new Error(`gs ${res.status}`);
}

export const logout = createServerFn({ method: "POST" }).handler(async () => {
  const s = await session();
  await s.clear();
  // Single-logout: además de la sesión de Teams, cerramos la del IdP (gs). Si no,
  // /login auto-reautentica en silencio con la sesión de gs viva → "vuelve a iniciarla
  // sin más". Mandamos a gs /logout (top-level) → limpia gs_session → aterriza en el
  // landing de Ghosty.studio (sin ver el card puente de Teams).
  return { ok: true as const, next: `${IDP}/logout` };
});
