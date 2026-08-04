import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense, useState } from "react";
import { Loader2 } from "lucide-react";
import { inviteCollabConnFn } from "../server/collab-invite";
import type { GuestConn } from "../server/collab-guest";
import { useT } from "../i18n";

// Canje de una invitación nominal: /coeditar/invitacion/<token>.
//
// Es la puerta "seria": el token llegó a un correo concreto, así que quien entra queda
// atribuido a esa persona aunque no tenga cuenta. La otra puerta (/coeditar/<slug>, el
// enlace abierto) da acceso pero no identidad.
//
// Se sigue pidiendo el nombre, pero aquí es sólo para mostrarlo junto al caret: el
// correo es lo que identifica, y viene del token, no del formulario.

const CollabEditor = lazy(() => import("../components/CollabEditor"));

function Centro({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-dvh place-items-center bg-[#f3f3f5] p-6">{children}</div>;
}

function Invitacion() {
  const t = useT();
  const { token } = Route.useParams();
  const [conn, setConn] = useState<GuestConn | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nombre, setNombre] = useState("");
  const [entrando, setEntrando] = useState(false);

  const entrar = async () => {
    setEntrando(true);
    setError(null);
    try {
      const r = await inviteCollabConnFn({ data: { token, name: nombre } });
      if (r.ok) setConn(r.conn);
      else setError(r.error);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setEntrando(false);
    }
  };

  if (error) {
    return (
      <Centro>
        <div className="max-w-sm text-center">
          <p className="text-sm text-neutral-600">{error}</p>
          <p className="mt-2 text-xs text-neutral-400">
            {t("Pídele a quien te invitó que te mande una invitación nueva.")}
          </p>
        </div>
      </Centro>
    );
  }

  if (!conn) {
    return (
      <Centro>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            entrar();
          }}
          className="w-full max-w-sm rounded-xl bg-white p-8 shadow-[0_1px_2px_rgba(0,0,0,0.06),0_12px_32px_-12px_rgba(0,0,0,0.18)] ring-1 ring-neutral-200/70"
        >
          <h1 className="text-lg font-semibold text-neutral-800">{t("Te invitaron a un documento")}</h1>
          <p className="mt-1 text-sm text-neutral-500">
            {t("¿Cómo quieres que te vean los demás? Tu identidad ya viene con la invitación.")}
          </p>
          <input
            autoFocus
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            maxLength={40}
            placeholder={t("Tu nombre")}
            // El color va EXPLÍCITO: sin él lo tecleado heredaba un gris tenue y se leía
            // igual que el placeholder — parecía que no habías escrito nada.
            className="mt-4 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 caret-neutral-900 outline-none placeholder:text-neutral-400 focus:border-neutral-400 focus:ring-2 focus:ring-[#9870ED]/40"
          />
          <button
            type="submit"
            disabled={entrando}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:opacity-40"
          >
            {entrando ? <Loader2 size={15} className="animate-spin" /> : null}
            Entrar al documento
          </button>
        </form>
      </Centro>
    );
  }

  return (
    <div className="h-dvh">
      <Suspense
        fallback={
          <Centro>
            <Loader2 size={22} className="animate-spin text-neutral-400" />
          </Centro>
        }
      >
        <CollabEditor
          wsUrl={conn.wsUrl}
          room={conn.room}
          token={conn.token}
          initialHtml={conn.initialHtml}
          user={conn.user}
          role={conn.role}
        />
      </Suspense>
    </div>
  );
}

export const Route = createFileRoute("/coeditar/invitacion/$token")({ component: Invitacion });
