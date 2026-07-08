import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { startFormmyLogin, completeFormmyLogin, clearMeCache } from "../server/auth";
import { useT } from "../i18n";

export const Route = createFileRoute("/login")({
  loader: () => startFormmyLogin({ data: {} }),
  component: Login,
});

function Login() {
  const { url, formmyOrigin } = Route.useLoaderData();
  return <LoginCard url={url} formmyOrigin={formmyOrigin} />;
}

// Reutilizado por /login y /join/:token.
export function LoginCard({
  url,
  formmyOrigin,
  inviteToken,
  subtitle,
}: {
  url: string;
  formmyOrigin: string;
  inviteToken?: string;
  subtitle?: string;
}) {
  const t = useT();
  const router = useRouter();
  // "probing" = intento de SSO silencioso en curso (arranca así para no parpadear
  // el botón cuando ya hay sesión de Formmy). Cae a "idle" (botón) si no hay sesión.
  const [state, setState] = useState<"probing" | "idle" | "waiting" | "error">("probing");
  const [error, setError] = useState<string | null>(null);

  function onIdentity(payload: string, sig: string) {
    completeFormmyLogin({ data: { payload, sig, inviteToken } })
      .then(() => {
        clearMeCache(); // la sesión cambió → refresca la identidad cacheada
        router.navigate({ to: "/" });
      })
      .catch((err) => {
        setState("error");
        setError(err?.message ? String(err.message) : t("No se pudo iniciar sesión"));
      });
  }

  // SSO SILENCIOSO: al montar, probar la sesión de Formmy en un iframe oculto
  // (`silent=1`). Si ya hay sesión → identidad firmada → entra sin click. Si no
  // (o timeout) → muestra el botón. teams.formmy.app y formmy.app son same-site,
  // así que la cookie de Formmy viaja en el iframe.
  useEffect(() => {
    let settled = false;
    const iframe = document.createElement("iframe");
    iframe.style.display = "none";
    iframe.src = url + (url.includes("?") ? "&" : "?") + "silent=1";
    function cleanup() {
      window.removeEventListener("message", onMsg);
      clearTimeout(timer);
      iframe.remove();
    }
    function onMsg(e: MessageEvent) {
      if (e.origin !== formmyOrigin || settled) return;
      const d = e.data as { type?: string; payload?: string; sig?: string };
      if (d?.type === "ghosty-identity" && d.payload && d.sig) {
        settled = true;
        cleanup();
        onIdentity(d.payload, d.sig);
      } else if (d?.type === "ghosty-no-session") {
        settled = true;
        cleanup();
        setState("idle");
      }
    }
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        setState("idle");
      }
    }, 3500);
    window.addEventListener("message", onMsg);
    document.body.appendChild(iframe);
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function connect() {
    setState("waiting");
    setError(null);
    // Popup centrado en la ventana (fallback manual del SSO silencioso).
    const w = 480;
    const h = 680;
    const left = window.screenX + Math.max(0, (window.outerWidth - w) / 2);
    const top = window.screenY + Math.max(0, (window.outerHeight - h) / 2);
    const popup = window.open(
      url,
      "formmy-login",
      `width=${w},height=${h},left=${Math.round(left)},top=${Math.round(top)}`
    );
    let done = false;
    let timer: ReturnType<typeof setInterval>;
    function cleanup() {
      window.removeEventListener("message", onMsg);
      clearInterval(timer);
    }
    function onMsg(e: MessageEvent) {
      if (e.origin !== formmyOrigin) return;
      const d = e.data as { type?: string; payload?: string; sig?: string };
      if (d?.type === "ghosty-identity" && d.payload && d.sig) {
        done = true;
        cleanup();
        popup?.close();
        onIdentity(d.payload, d.sig);
      }
    }
    window.addEventListener("message", onMsg);
    // Si cierran el popup sin completar → desbloquea el botón.
    timer = setInterval(() => {
      if (popup?.closed && !done) {
        cleanup();
        setState("idle");
      }
    }, 500);
  }

  return (
    <div className="grid min-h-screen place-items-center bg-surface p-6 text-ink">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-surface-2 p-8 text-center">
        <img src="/ghosty.svg" alt="Ghosty" className="mx-auto h-16 w-16" />
        <h1 className="mt-4 text-lg font-semibold">Ghosty Teams</h1>
        <p className="mt-1 text-sm text-muted">{subtitle ?? t("Entra con tu cuenta de Formmy.")}</p>
        {state === "probing" ? (
          <p className="mt-5 text-sm text-muted">{t("Entrando…")}</p>
        ) : (
          <button
            onClick={connect}
            disabled={state === "waiting"}
            className="mt-5 w-full cursor-pointer rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-brand-fg transition hover:brightness-110 hover:shadow-lg hover:shadow-brand/30 active:scale-[0.98] disabled:cursor-default disabled:opacity-50 disabled:hover:brightness-100 disabled:hover:shadow-none"
          >
            {state === "waiting" ? t("Esperando a Formmy…") : t("Entrar con Formmy")}
          </button>
        )}
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      </div>
    </div>
  );
}
