import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { startGhostyLogin, completeGhostyLogin, clearMeCache } from "../server/auth";
import { useT } from "../i18n";

export const Route = createFileRoute("/login")({
  loader: () => startGhostyLogin({ data: {} }),
  component: Login,
});

function Login() {
  const { url } = Route.useLoaderData();
  return <LoginCard url={url} />;
}

// Reutilizado por /login y /join/:token.
export function LoginCard({
  url,
  inviteToken,
  subtitle,
}: {
  url: string;
  inviteToken?: string;
  subtitle?: string;
}) {
  const t = useT();
  const router = useRouter();
  const [state, setState] = useState<"idle" | "waiting" | "completing" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  function onIdentity(payload: string, sig: string) {
    setState("completing");
    completeGhostyLogin({ data: { payload, sig, inviteToken } })
      .then(() => {
        clearMeCache(); // la sesión cambió → refresca la identidad cacheada
        router.navigate({ to: "/" });
      })
      .catch((err) => {
        setState("error");
        setError(err?.message ? String(err.message) : t("No se pudo iniciar sesión"));
      });
  }

  // Al volver del IdP (ghosty.studio) por redirect top-level llega `?payload&sig`.
  // Lo consumimos y limpiamos la query para que un back/refresh no reintente con
  // firma vieja.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const cbPayload = q.get("payload");
    const cbSig = q.get("sig");
    if (cbPayload && cbSig) {
      window.history.replaceState({}, "", window.location.pathname);
      onIdentity(cbPayload, cbSig);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function connect() {
    setState("waiting");
    setError(null);
    // Redirect TOP-LEVEL a ghosty.studio (IdP). En mobile / PWA standalone los
    // popups (`window.open`) se abren en otra pestaña y rompen el opener → el
    // postMessage nunca llega. Navegando la ventana completa, la cookie del IdP
    // viaja first-party (ITP no la bloquea) y el IdP nos regresa por 302 con
    // ?payload&sig. `return` preserva la ruta (para que /join/<token> vuelva a sí).
    const sep = url.includes("?") ? "&" : "?";
    const ret = encodeURIComponent(window.location.pathname);
    window.location.href = `${url}${sep}return=${ret}`;
  }

  const busy = state === "waiting" || state === "completing";
  return (
    <div className="grid min-h-[100dvh] place-items-center bg-surface text-ink pl-[max(1.5rem,env(safe-area-inset-left))] pr-[max(1.5rem,env(safe-area-inset-right))] pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-surface-2 p-8 text-center">
        <img src="/ghosty.svg" alt="Ghosty" className="mx-auto h-16 w-16" />
        <h1 className="mt-4 text-lg font-semibold">Ghosty Teams</h1>
        <p className="mt-1 text-sm text-muted">{subtitle ?? t("Entra con tu cuenta de Ghosty.")}</p>
        {state === "completing" ? (
          <p className="mt-5 text-sm text-muted">{t("Entrando…")}</p>
        ) : (
          <button
            onClick={connect}
            disabled={busy}
            className="mt-5 w-full min-h-[44px] cursor-pointer rounded-lg bg-brand px-4 py-3 text-sm font-semibold text-brand-fg transition hover:brightness-110 hover:shadow-lg hover:shadow-brand/30 active:scale-[0.98] disabled:cursor-default disabled:opacity-50 disabled:hover:brightness-100 disabled:hover:shadow-none"
          >
            {state === "waiting" ? t("Redirigiendo…") : t("Continuar con Ghosty")}
          </button>
        )}
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      </div>
    </div>
  );
}
