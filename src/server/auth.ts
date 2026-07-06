import { createServerFn } from "@tanstack/react-start";

// Sesión + login con Formmy (identidad). Formmy = quién eres; EasyBits = recursos.
const FORMMY = process.env.FORMMY_BASE_URL ?? "https://formmy.app";

async function session() {
  const { useSession } = await import("@tanstack/react-start/server");
  const { sessionConfig } = await import("./session.server");
  return useSession<{ user?: import("../users.server").SessionUser }>(sessionConfig());
}

export const me = createServerFn({ method: "GET" }).handler(async () => {
  const s = await session();
  return s.data.user ?? null;
});

// Devuelve el URL firmado del popup de identidad de Formmy (firma opener→Formmy).
export const startFormmyLogin = createServerFn({ method: "GET" })
  .validator((d: { inviteToken?: string } | undefined) => d ?? {})
  .handler(async ({ data }) => {
    const crypto = await import("node:crypto");
    // El origin se deriva del request (cada sandbox tiene su URL) — multitenant,
    // sin env fijo. Detrás del proxy EasyBits el host público va en x-forwarded-*.
    // APP_URL solo como override opcional.
    let origin = process.env.APP_URL ?? "";
    if (!origin) {
      const { getRequestHeader, getRequestHost, getRequestProtocol } = await import(
        "@tanstack/react-start/server"
      );
      // 1) x-ghosty-origin: lo pone el ingress de teams.formmy.app y EasyBits NO
      //    lo toca (header custom) → origin = dominio estable. Gana sobre todo.
      // 2) x-forwarded-host: acceso directo al sb-xxx (EasyBits lo setea).
      // 3) Host crudo (=localhost:3000 dentro de la VM) como último recurso.
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
      .createHmac("sha256", process.env.FORMMY_PARTNER_SECRET_GHOSTY!)
      .update(`${ts}.${origin}`)
      .digest("hex");
    const p = new URLSearchParams({ ts: String(ts), sig, o: origin, p: "ghosty-chat" });
    return { url: `${FORMMY}/identity/connect?${p}`, formmyOrigin: FORMMY, inviteToken: data.inviteToken };
  });

// Recibe la identidad firmada por Formmy (firma Formmy→opener), crea sesión.
export const completeFormmyLogin = createServerFn({ method: "POST" })
  .validator((d: { payload: string; sig: string; inviteToken?: string }) => d)
  .handler(async ({ data }) => {
    const crypto = await import("node:crypto");
    const secret = process.env.FORMMY_PARTNER_SECRET_GHOSTY!;
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

    const { upsertUser } = await import("../users.server");
    const user = await upsertUser({ sub: id.sub, email: id.email, name: id.name, avatar: id.avatar });

    // Un no-owner sin invitación no puede entrar (solo el owner y los invitados).
    if (!user.isOwner && !invited) {
      const { isKnownUser } = await import("./invites");
      if (!(await isKnownUser(id.sub))) throw new Error("necesitas una invitación");
    }

    const s = await session();
    await s.update({ user });
    return { ok: true as const, user };
  });

export const logout = createServerFn({ method: "POST" }).handler(async () => {
  const s = await session();
  await s.clear();
  return { ok: true as const };
});
