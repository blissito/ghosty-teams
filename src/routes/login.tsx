import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { startFormmyLogin, completeFormmyLogin } from "../server/auth";

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
  const router = useRouter();
  const [state, setState] = useState<"idle" | "waiting" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  function connect() {
    setState("waiting");
    setError(null);
    // Popup centrado en la ventana.
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
        completeFormmyLogin({ data: { payload: d.payload, sig: d.sig, inviteToken } })
          .then(() => router.navigate({ to: "/" }))
          .catch((err) => {
            setState("error");
            setError(err?.message ? String(err.message) : "No se pudo iniciar sesión");
          });
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
        <p className="mt-1 text-sm text-muted">{subtitle ?? "Entra con tu cuenta de Formmy."}</p>
        <button
          onClick={connect}
          disabled={state === "waiting"}
          className="mt-5 w-full cursor-pointer rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-brand-fg transition hover:brightness-110 hover:shadow-lg hover:shadow-brand/30 active:scale-[0.98] disabled:cursor-default disabled:opacity-50 disabled:hover:brightness-100 disabled:hover:shadow-none"
        >
          {state === "waiting" ? "Esperando a Formmy…" : "Entrar con Formmy"}
        </button>
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      </div>
    </div>
  );
}
