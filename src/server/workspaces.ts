import { createServerFn } from "@tanstack/react-start";

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
