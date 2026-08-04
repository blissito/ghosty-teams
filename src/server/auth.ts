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
  const user = s.data.user;
  if (!user) return null;

  // El rol se RELEE de la DB, no se cree lo que trae la cookie. `isOwner` se selló al
  // hacer login y una cookie dura 30 días: un traspaso de dueño (o un cambio de rol)
  // no se veía hasta que la persona volviera a entrar — la UI seguía diciendo
  // "Miembro" con la DB diciendo lo contrario. Verificado en vivo el 2026-07-31.
  //
  // Es una query por render de identidad; barata y por índice (gc_users.sub es UNIQUE).
  // Si falla, se devuelve lo de la sesión: un hipo de DB no puede tirar el login.
  try {
    const { dbqRaw } = await import("../dbq.server");
    const { rows } = await dbqRaw("SELECT is_owner FROM gc_users WHERE sub = ?", [user.sub]);
    if (!rows[0]) return user;
    // ⚠️ `resolvePermissions` y NO `Number(...) === 1` a secas: el STAFF tiene poder de
    // owner con `is_owner=0` en la DB, así que leer la columna cruda le quitaría el
    // permiso en el primer render — otorgado al entrar y perdido acto seguido, sin error
    // ni rastro. Es la MISMA función que usa `upsertUser`, para que no puedan divergir.
    const { resolvePermissions } = await import("../users.server");
    const perms = await resolvePermissions(user.email, Number(rows[0][0]) === 1);
    if (perms.isOwner === user.isOwner && perms.isStaff === user.isStaff) return user;
    const fresh = { ...user, ...perms };
    await s.update({ user: fresh }); // que la cookie deje de mentir
    return fresh;
  } catch {
    return user;
  }
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
    // `crawler`: el llamante es un bot de vista previa de liga. El loader lo usa para NO
    // rebotar al IdP y dejar que se renderice la tarjeta con las og:* — un crawler no
    // sigue un redirect cross-domain y sin esto la preview sale pelona. Ver
    // `crawler.server.ts`. Va aquí, y no en el loader de la ruta, porque `login.tsx` lo
    // alcanza el cliente y el plugin de protección de TanStack le prohíbe —estática o
    // dinámicamente— importar un módulo `.server`.
    const { isLinkPreviewCrawler } = await import("../crawler.server");
    return {
      url: `${IDP}/identity/connect?${p}`,
      idpOrigin: IDP,
      inviteToken: data.inviteToken,
      crawler: await isLinkPreviewCrawler(),
    };
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

    // Asegura el schema del namespace ANTES de cualquier query (columnas nuevas como
    // banned/status_*/email_notifs). Un workspace NUEVO (primer login = se crea) o uno
    // que no ha corrido ensureSchema rompería con "no such column" si no. Idempotente.
    await (await import("./schema.server")).ensureSchema().catch(() => {});

    const { consumeInvite } = await import("./invites");
    // Si trae invite, valídalo (member). Sin invite solo entra si ya hay owner
    // (o es el primer login = owner).
    const invited = data.inviteToken ? await consumeInvite(data.inviteToken, id.sub) : false;

    // Expulsado del workspace → rebota (aunque tenga identidad IdP válida). Antes del
    // upsert para no re-crearlo/tocarlo.
    // El STAFF pasa el ban. `expelMember` ya se niega a banearlo, pero esto cubre las
    // filas baneadas de antes y cualquier camino que escriba la columna a mano: como el
    // ban se comprueba ANTES de la puerta, una sola fila mal puesta dejaría al creador
    // fuera de un workspace para siempre, sin forma de arreglarlo desde dentro.
    const { isBanned, isStaffEmail } = await import("../users.server");
    if ((await isBanned(id.sub)) && !(await isStaffEmail(id.email)))
      throw new Error("sin acceso a este workspace");

    // ── Puerta de acceso al workspace ────────────────────────────────────────
    // ANTES de crear nada. Estaba DESPUÉS del upsert y preguntaba `isKnownUser`,
    // que encontraba la fila recién insertada → la condición nunca se cumplía y
    // cualquiera con una identidad válida entraba a cualquier workspace sabiendo
    // el subdominio. Se entra sólo si: ya eras de la casa, traes invitación, o el
    // workspace está vacío (primer login = su dueño).
    // El dueño DECLARADO (workspace montado por nosotros para un cliente) entra
    // siempre: preparar su espacio antes de que llegue lo dejaba fuera del suyo, que
    // es justo el caso para el que se creó la clave.
    // Cuarta forma legítima de entrar: staff. Es el espacio que le montamos al cliente y
    // que vamos a estar probando con él; pedirle una invitación para entrar a lo que
    // nosotros preparamos es una vuelta absurda. Se da y se quita por workspace desde
    // `/admin/tenants` (gs), y no ocupa uno de sus asientos.
    // Quinta: dado de alta A MANO por correo desde `/admin/tenants`. Es lo que hace que
    // meter a alguien no cueste una liga que mandar ni un token que caduque: se escribe su
    // correo y entra con el login que ya usa. A diferencia del staff, éstos SÍ ocupan
    // asiento — son gente del cliente.
    const { isKnownUser, isEmptyWorkspace } = await import("./invites");
    const { isIntendedOwner, isPreapprovedEmail } = await import("../users.server");
    if (
      !invited &&
      !(await isKnownUser(id.sub)) &&
      !(await isEmptyWorkspace()) &&
      !(await isIntendedOwner(id.email)) &&
      !(await isStaffEmail(id.email)) &&
      !(await isPreapprovedEmail(id.email))
    ) {
      throw new Error("necesitas una invitación");
    }

    // El tope de asientos NO se comprueba aquí: no bloquea a nadie (decidido el
    // 2026-08-03). gs cuenta y nos avisa en su panel a quién llamar; la única puerta de
    // este workspace sigue siendo la invitación, arriba.
    const { upsertUser } = await import("../users.server");
    const user = await upsertUser({ sub: id.sub, email: id.email, name: id.name, avatar: id.avatar });

    // Registra `Membership(MEMBER)` en gs (fuente única de verdad de membership+rol).
    // Corre para TODO el que cruzó la puerta, no sólo para el invitado: quien entra a un
    // workspace vacío o como dueño declarado también es miembro, y sin la fila el
    // switcher multi-workspace NO se lo muestra — el workspace le queda invisible aunque
    // esté dentro. `internal.memberships` hace upsert con `update:{}`, así que repetirlo
    // en cada login no pisa un rol ya asignado.
    // Best-effort: no bloquea el login si gs falla (el siguiente login lo reconcilia).
    try {
      await registerMembership(id.sub);
    } catch (e) {
      console.warn("[auth] registerMembership falló (best-effort):", (e as Error)?.message);
    }

    const s = await session();
    await s.update({ user });
    return { ok: true as const, user };
  });

// Registra Membership(MEMBER) del invitado en gs (control-plane), firmado HMAC
// `ts.sub.slug`. El slug sale del subdominio del request (tenant.server). En apex/dev
// sin subdominio no hay workspace que registrar → no-op.
async function registerMembership(sub: string): Promise<void> {
  const q = await membershipQuery(sub);
  if (!q) return;
  const res = await fetch(`${IDP}/internal/memberships?${q}`, { method: "POST" });
  if (!res.ok) throw new Error(`gs ${res.status}`);
}

/** Query firmada (`ts.sub.slug`) del GET y el POST de `/internal/memberships`.
 *  `null` en apex/dev, donde no hay subdominio del que sacar el slug. */
async function membershipQuery(sub: string): Promise<string | null> {
  const { currentSlug } = await import("./tenant.server");
  const slug = await currentSlug();
  if (!slug) return null;
  const crypto = await import("node:crypto");
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto
    .createHmac("sha256", process.env.GHOSTY_PARTNER_SECRET!)
    .update(`${ts}.${sub}.${slug}`)
    .digest("hex");
  return new URLSearchParams({ sub, slug, ts: String(ts), sig }).toString();
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
