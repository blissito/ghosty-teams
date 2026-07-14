import { createFileRoute, useRouter, Link, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { getSetup, selectFleetAgent, createFleetAgent, disconnectSetup } from "../server/setup";
import { me, logout } from "../server/auth";
import { useT } from "../i18n";

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
  const t = useT();
  const { user, connected, hasAgent, fleetName, agents } = Route.useLoaderData();
  const router = useRouter();
  async function doLogout() {
    await logout();
    router.navigate({ to: "/login" });
  }
  const [busy, setBusy] = useState<string | null>(null);

  const step = !connected ? 1 : !hasAgent ? 2 : 3;

  // Elegir un agente existente es barato/reversible → optimista está OK aquí.
  async function pick(id: string) {
    setBusy(id);
    try {
      await selectFleetAgent({ data: { id } });
    } finally {
      await router.invalidate();
      setBusy(null);
    }
  }

  // Crear un agente CREA un recurso real (VMs, cuota) → NADA de optimismo: espera
  // a que el server confirme y recién ahí avanza. Si no, se sentía "creó sin
  // preguntar ni terminar". El botón mismo es la confirmación.
  async function create(engine: "deepseek" | "claude") {
    setBusy(`new:${engine}`);
    try {
      await createFleetAgent({ data: { engine } });
    } finally {
      await router.invalidate();
      setBusy(null);
    }
  }

  // Volver: paso 3 → 2 (cambiar agente) o paso 2 → 1 (desconectar EasyBits).
  async function goBack(scope: "agent" | "easybits") {
    setBusy(`back:${scope}`);
    try {
      await disconnectSetup({ data: { scope } });
    } finally {
      await router.invalidate();
      setBusy(null);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-surface p-6 text-ink">
      <div className="w-full max-w-md rounded-2xl border border-border bg-surface-2 p-8">
        <div className="mb-4 flex items-center justify-between border-b border-border pb-3 text-xs text-muted">
          <span className="truncate">{user?.email}</span>
          <button onClick={doLogout} className="shrink-0 text-brand hover:underline">
            {t("Cerrar sesión")}
          </button>
        </div>
        <div className="mb-6 flex items-center gap-3">
          <img src="/ghosty.svg" alt="" className="h-10 w-10" />
          <div>
            <h1 className="font-semibold">{t("Configura tu Ghosty Teams")}</h1>
            <p className="text-xs text-muted">{t("Paso {step} de 2", { step })}</p>
          </div>
        </div>

        {/* Paso 1 — conectar EasyBits */}
        <Stepline n={1} done={connected} active={step === 1} title={t("Conecta tu EasyBits")}>
          {step === 1 && (
            <>
              <p className="mb-3 text-sm text-muted">
                {t("Ghosty vive de tus recursos EasyBits (agentes, storage, cómputo). Conecta tu cuenta para empezar.")}
              </p>
              <a
                href="/setup/easybits/connect"
                className="inline-block rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-brand-fg hover:opacity-90"
              >
                {t("Conectar EasyBits")}
              </a>
            </>
          )}
        </Stepline>

        {/* Paso 2 — elegir agente */}
        <Stepline n={2} done={hasAgent} active={step === 2} title={t("Elige tu agente Ghosty")}>
          {step === 2 && (
            <div className="space-y-2">
              {/* Crear un @ghosty nuevo — Flash por default (rápido), Claude opcional */}
              <button
                onClick={() => create("deepseek")}
                disabled={!!busy}
                className="flex w-full items-center justify-between rounded-lg border border-brand bg-brand/10 px-3 py-2 text-left text-sm hover:bg-brand/20 disabled:opacity-50"
              >
                <span className="flex items-center gap-2">
                  <img src="/ghosty.svg" alt="" className="h-5 w-5" />
                  <span className="font-medium text-ink">{t("Crear Ghosty")}</span>
                </span>
                <span className="text-xs text-muted">
                  {busy === "new:deepseek" ? t("creando…") : t("DeepSeek Flash · rápido")}
                </span>
              </button>
              <button
                onClick={() => create("claude")}
                disabled={!!busy}
                className="flex w-full items-center justify-between rounded-lg border border-border bg-surface px-3 py-2 text-left text-sm hover:border-brand disabled:opacity-50"
              >
                <span className="flex items-center gap-2">
                  <img src="/ghosty.svg" alt="" className="h-5 w-5" />
                  <span className="font-medium text-ink">{t("Crear Ghosty")}</span>
                </span>
                <span className="text-xs text-muted">
                  {busy === "new:claude" ? t("creando…") : t("Claude Sonnet · capaz")}
                </span>
              </button>

              {agents.length > 0 && (
                <p className="pt-2 text-xs text-muted">{t("O usa uno existente:")}</p>
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
                    {busy === a.id ? t("conectando…") : a.workerTemplate}
                  </span>
                </button>
              ))}

              {/* Volver al paso 1 */}
              <button
                onClick={() => goBack("easybits")}
                disabled={!!busy}
                className="pt-2 text-xs text-muted hover:text-brand disabled:opacity-50"
              >
                {busy === "back:easybits" ? t("desconectando…") : t("← Desconectar EasyBits")}
              </button>
            </div>
          )}
        </Stepline>

        {/* Listo */}
        {step === 3 && (
          <div className="mt-4 rounded-lg bg-brand/10 p-4 text-center">
            <p className="text-sm text-ink">
              ✅ <span className="font-medium">{fleetName || "Ghosty"}</span> {t("conectado.")}
            </p>
            <Link
              to="/c/$slug"
              params={{ slug: "general" }}
              className="mt-3 inline-block rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-brand-fg"
            >
              {t("Ir al chat →")}
            </Link>
            <div>
              <button
                onClick={() => goBack("agent")}
                disabled={!!busy}
                className="mt-3 text-xs text-muted hover:text-brand disabled:opacity-50"
              >
                {busy === "back:agent" ? t("cambiando…") : t("← Cambiar agente")}
              </button>
            </div>
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
