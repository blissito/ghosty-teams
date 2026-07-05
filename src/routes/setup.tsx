import { createFileRoute, useRouter, Link, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { getSetup, selectFleetAgent } from "../server/setup";
import { me, logout } from "../server/auth";

// Wizard de onboarding del owner. Para iniciar: conecta EasyBits → elige agente.
export const Route = createFileRoute("/setup")({
  loader: async () => {
    const user = await me();
    if (!user?.isOwner) throw redirect({ to: "/c/$slug", params: { slug: "general" } });
    const setup = await getSetup();
    return { user, ...setup };
  },
  component: Setup,
});

function Setup() {
  const { user, connected, hasAgent, fleetName, agents } = Route.useLoaderData();
  const router = useRouter();
  async function doLogout() {
    await logout();
    router.navigate({ to: "/login" });
  }
  const [busy, setBusy] = useState<string | null>(null);

  const step = !connected ? 1 : !hasAgent ? 2 : 3;

  async function pick(id: string) {
    setBusy(id);
    await selectFleetAgent({ data: { id } });
    router.invalidate();
    setBusy(null);
  }

  return (
    <div className="grid min-h-screen place-items-center bg-surface p-6 text-ink">
      <div className="w-full max-w-md rounded-2xl border border-border bg-surface-2 p-8">
        <div className="mb-4 flex items-center justify-between border-b border-border pb-3 text-xs text-muted">
          <span className="truncate">{user?.email}</span>
          <button onClick={doLogout} className="shrink-0 text-brand hover:underline">
            Cerrar sesión
          </button>
        </div>
        <div className="mb-6 flex items-center gap-3">
          <img src="/ghosty.svg" alt="" className="h-10 w-10" />
          <div>
            <h1 className="font-semibold">Configura tu Ghosty Teams</h1>
            <p className="text-xs text-muted">Paso {step} de 2</p>
          </div>
        </div>

        {/* Paso 1 — conectar EasyBits */}
        <Stepline n={1} done={connected} active={step === 1} title="Conecta tu EasyBits">
          {step === 1 && (
            <>
              <p className="mb-3 text-sm text-muted">
                Ghosty vive de tus recursos EasyBits (agentes, storage, cómputo).
                Conecta tu cuenta para empezar.
              </p>
              <a
                href="/setup/easybits/connect"
                className="inline-block rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-brand-fg hover:opacity-90"
              >
                Conectar EasyBits
              </a>
            </>
          )}
        </Stepline>

        {/* Paso 2 — elegir agente */}
        <Stepline n={2} done={hasAgent} active={step === 2} title="Elige tu agente Ghosty">
          {step === 2 && (
            <div className="space-y-2">
              {agents.length === 0 && (
                <p className="text-sm text-muted">
                  No encontré agentes de flota en tu cuenta. Crea uno en EasyBits y recarga.
                </p>
              )}
              {agents.map((a) => (
                <button
                  key={a.id}
                  onClick={() => pick(a.id)}
                  disabled={!!busy}
                  className="flex w-full items-center justify-between rounded-lg border border-border bg-surface px-3 py-2 text-left text-sm hover:border-brand disabled:opacity-50"
                >
                  <span className="flex items-center gap-2">
                    <img src="/ghosty.svg" alt="" className="h-5 w-5" />
                    <span className="font-medium text-ink">{a.name}</span>
                  </span>
                  <span className="text-xs text-muted">
                    {busy === a.id ? "conectando…" : a.workerTemplate}
                  </span>
                </button>
              ))}
            </div>
          )}
        </Stepline>

        {/* Listo */}
        {step === 3 && (
          <div className="mt-4 rounded-lg bg-brand/10 p-4 text-center">
            <p className="text-sm text-ink">
              ✅ <span className="font-medium">{fleetName || "Ghosty"}</span> conectado.
            </p>
            <Link
              to="/c/$slug"
              params={{ slug: "general" }}
              className="mt-3 inline-block rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-brand-fg"
            >
              Ir al chat →
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

function Stepline({
  n,
  done,
  active,
  title,
  children,
}: {
  n: number;
  done: boolean;
  active: boolean;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex gap-3">
      <div
        className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold ${
          done ? "bg-brand text-brand-fg" : active ? "border-2 border-brand text-brand" : "bg-surface-3 text-muted"
        }`}
      >
        {done ? "✓" : n}
      </div>
      <div className="flex-1">
        <h2 className={`text-sm font-semibold ${active || done ? "text-ink" : "text-muted"}`}>
          {title}
        </h2>
        <div className="mt-2">{children}</div>
      </div>
    </div>
  );
}
