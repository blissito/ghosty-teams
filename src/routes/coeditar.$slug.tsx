import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense, useState } from "react";
import { Loader2 } from "lucide-react";
import { useT } from "../i18n";
import { guestCollabConnFn, type GuestConn } from "../server/collab-guest";

// Página de co-edición para INVITADOS: /coeditar/<slug>.
//
// Es la puerta de quien no tiene cuenta de GTeams. La otra puerta —el panel del room—
// exige sesión y saca el rol de la membresía; aquí el rol sale del `share_role` del
// enlace, y va firmado dentro del ticket: un enlace de comentar no se convierte en
// editor por tocar el cliente.
//
// Se pide el nombre antes de entrar. No es burocracia: sin nombre, el caret ajeno y el
// rail de avatares dicen "Invitada" para todos y la presencia deja de significar algo.

const CollabEditor = lazy(() => import("../components/CollabEditor"));

function Centro({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-dvh place-items-center bg-[#f3f3f5] p-6">{children}</div>;
}

function Puerta({ onEntrar }: { onEntrar: (nombre: string) => void }) {
  const t = useT();
  const [nombre, setNombre] = useState("");
  return (
    <Centro>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onEntrar(nombre);
        }}
        className="w-full max-w-sm rounded-xl bg-surface p-8 shadow-[0_1px_2px_rgba(0,0,0,0.06),0_12px_32px_-12px_rgba(0,0,0,0.18)] ring-1 ring-border"
      >
        <h1 className="text-lg font-semibold text-ink">{t("Te invitaron a un documento")}</h1>
        <p className="mt-1 text-sm text-muted">
          {t("¿Cómo te llamas? Es lo que verán los demás junto a tu cursor.")}
        </p>
        <input
          autoFocus
          value={nombre}
          onChange={(e) => setNombre(e.target.value)}
          maxLength={40}
          placeholder={t("Tu nombre")}
          // El color va EXPLÍCITO: sin él lo tecleado heredaba un gris tenue y se leía
          // igual que el placeholder — parecía que no habías escrito nada.
          className="mt-4 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink caret-ink outline-none placeholder:text-muted focus:border-brand focus:ring-2 focus:ring-brand/40"
        />
        <button
          type="submit"
          disabled={!nombre.trim()}
          className="mt-4 w-full rounded-md bg-brand px-3 py-2 text-sm font-medium text-brand-fg transition hover:opacity-90 disabled:opacity-40"
        >
          Entrar al documento
        </button>
      </form>
    </Centro>
  );
}

function Coeditar() {
  const t = useT();
  const { slug } = Route.useParams();
  const [conn, setConn] = useState<GuestConn | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entrando, setEntrando] = useState(false);

  const entrar = async (nombre: string) => {
    setEntrando(true);
    setError(null);
    try {
      const r = await guestCollabConnFn({ data: { slug, name: nombre } });
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
          <p className="text-sm text-muted">{error}</p>
          <p className="mt-2 text-xs text-muted">
            {t("Pídele a quien te compartió el documento que revise el enlace.")}
          </p>
        </div>
      </Centro>
    );
  }
  if (entrando) {
    return (
      <Centro>
        <Loader2 size={22} className="animate-spin text-muted" />
      </Centro>
    );
  }
  if (!conn) return <Puerta onEntrar={entrar} />;

  return (
    <div className="h-dvh">
      <Suspense
        fallback={
          <Centro>
            <Loader2 size={22} className="animate-spin text-muted" />
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

export const Route = createFileRoute("/coeditar/$slug")({ component: Coeditar });
