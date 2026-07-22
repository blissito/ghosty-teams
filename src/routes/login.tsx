import { createFileRoute, redirect } from "@tanstack/react-router";
import { startGhostyLogin, completeGhostyLogin, clearMeCache } from "../server/auth";
import { useT } from "../i18n";

// Search params del handshake: `payload`/`sig` = identidad firmada de vuelta del IdP;
// `attempted` = marca puesta en el `return` de ida para detectar la vuelta-sin-identidad
// (anti-loop). El IdP preserva el query del `return` (URL.searchParams.set), así que
// `return=/login?attempted=1` vuelve como `/login?attempted=1&payload&sig`.
export type LoginSearch = { payload?: string; sig?: string; attempted?: boolean };

export function parseLoginSearch(s: Record<string, unknown>): LoginSearch {
  return {
    payload: typeof s.payload === "string" ? s.payload : undefined,
    sig: typeof s.sig === "string" ? s.sig : undefined,
    attempted:
      s.attempted === "1" || s.attempted === 1 || s.attempted === true ? true : undefined,
  };
}

// Loader ISOMÓRFICO del login: el card SOBRA en el happy path. En vez de montarlo y
// auto-redirigir desde un effect (flash "Redirigiendo…/Entrando…"), el loader hace todo
// server-side —
//   1. Sin params → 302 top-level al IdP (con `return=<path>?attempted=1`). Cero card.
//   2. Vuelta con ?payload&sig → completa la sesión server-side (el Set-Cookie viaja en
//      el 302, igual que setup.easybits.connect) y 302 a "/".
//   3. Vuelta con ?attempted pero sin identidad, o error al completar → devuelve `{ error }`
//      y se pinta LoginCard como FALLBACK manual (sin re-redirigir solo → anti-loop).
export async function runLoginLoader(search: LoginSearch, inviteToken?: string) {
  if (search.payload && search.sig) {
    let error: string | null = null;
    try {
      await completeGhostyLogin({
        data: { payload: search.payload, sig: search.sig, inviteToken },
      });
    } catch (e) {
      error = (e as Error)?.message || "No se pudo iniciar sesión";
    }
    if (!error) {
      // La sesión cambió → invalida la identidad cacheada para que la nav a "/" lea
      // fresco (en SSR es no-op; importa en nav de cliente donde _meCache seguiría null).
      clearMeCache();
      throw redirect({ to: "/" });
    }
    return { error };
  }
  if (search.attempted) {
    // Volvimos del IdP sin identidad (cancelado / sin sesión gs). NO re-redirigir solo:
    // el usuario reintenta con el botón (anti-loop).
    return { error: null as string | null };
  }
  // Primer intento: rebote server-side al IdP. `return` lleva ?attempted=1 para que una
  // vuelta-sin-identidad caiga al fallback manual en vez de re-rebotar en bucle.
  const { url } = await startGhostyLogin({ data: { inviteToken } });
  // `attempted=true` (no `=1`): TanStack coacciona `1`→boolean y re-serializa a `true`,
  // metiendo un redirect de canonicalización extra. Generándolo ya como `true`, el
  // valor round-trip es estable y no hay hop intermedio.
  const retPath = `${inviteToken ? `/join/${inviteToken}` : "/login"}?attempted=true`;
  const sep = url.includes("?") ? "&" : "?";
  throw redirect({ href: `${url}${sep}return=${encodeURIComponent(retPath)}` });
}

export const Route = createFileRoute("/login")({
  validateSearch: (s: Record<string, unknown>) => parseLoginSearch(s),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => runLoginLoader(deps),
  component: Login,
});

function Login() {
  const { error } = Route.useLoaderData();
  return <LoginCard error={error} retryTo="/login" />;
}

// Fallback manual: SOLO se pinta cuando el redirect automático no ocurrió (vuelta del IdP
// sin identidad, o error al completar). Un click reintenta el flujo — navegación full-page
// a `retryTo`, cuyo loader rebota al IdP con un `ts` fresco. Reutilizado por /join/$token.
export function LoginCard({
  error,
  retryTo,
  subtitle,
}: {
  error: string | null;
  retryTo: string;
  subtitle?: string;
}) {
  const t = useT();
  return (
    <div className="grid min-h-[100dvh] place-items-center bg-surface text-ink pl-[max(1.5rem,env(safe-area-inset-left))] pr-[max(1.5rem,env(safe-area-inset-right))] pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-surface-2 p-8 text-center">
        <img src="/ghosty.svg" alt="Ghosty" className="mx-auto h-16 w-16" />
        <h1 className="mt-4 text-lg font-semibold">Ghosty Teams</h1>
        <p className="mt-1 text-sm text-muted">{subtitle ?? t("Entra con tu cuenta de Ghosty.")}</p>
        <a
          href={retryTo}
          className="mt-5 block w-full min-h-[44px] cursor-pointer rounded-lg bg-brand px-4 py-3 text-sm font-semibold text-brand-fg transition hover:brightness-110 hover:shadow-lg hover:shadow-brand/30 active:scale-[0.98]"
        >
          {t("Continuar con Ghosty")}
        </a>
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      </div>
    </div>
  );
}
