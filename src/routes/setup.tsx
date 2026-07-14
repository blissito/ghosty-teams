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
  // Paso efectivo: el server siembra el inicial, pero las mutaciones lo mueven en el
  // cliente al instante (router.invalidate() no re-corría el loader → "el botón no
  // hacía nada"). `over` = override local; null = usa el del server. Igual para el
  // nombre mostrado en el paso 3.
  const [over, setOver] = useState<{ step: number; fleetName?: string } | null>(null);
  const baseStep = !connected ? 1 : !hasAgent ? 2 : 3;
  const step = over?.step ?? baseStep;
  const shownName = over?.fleetName ?? fleetName;

  // Selección del paso 2 — SOLO resalta, sin efecto. El agente se crea/conecta hasta
  // "Continuar" (antes clickear ya creaba un FleetAgent en la flota = mal diseño).
  // Sel = motor nuevo { kind:"new", engine } | agente existente { kind:"existing", id, name }.
  type Sel =
    | { kind: "new"; engine: "deepseek" | "claude" }
    | { kind: "existing"; id: string; name: string };
  const [sel, setSel] = useState<Sel | null>(null);
  const selId =
    sel?.kind === "new" ? `new:${sel.engine}` : sel?.kind === "existing" ? sel.id : null;

  // Confirmar la selección: recién aquí se CREA (motor nuevo) o se conecta (existente).
  async function confirm() {
    if (!sel) return;
    setBusy("confirm");
    try {
      if (sel.kind === "new") {
        const r = await createFleetAgent({ data: { engine: sel.engine } });
        setOver({ step: 3, fleetName: r?.name ?? "Ghosty" });
      } else {
        await selectFleetAgent({ data: { id: sel.id } });
        setOver({ step: 3, fleetName: sel.name });
      }
    } finally {
      setBusy(null);
    }
  }

  // Volver: paso 3 → 2 (cambiar agente) o paso 2 → 1 (desconectar EasyBits).
  async function goBack(scope: "agent" | "easybits") {
    setBusy(`back:${scope}`);
    try {
      await disconnectSetup({ data: { scope } });
      setSel(null);
      setOver({ step: scope === "easybits" ? 1 : 2 });
    } finally {
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
        <Stepline n={1} done={step > 1} active={step === 1} title={t("Conecta tu EasyBits")}>
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
        <Stepline n={2} done={step > 2} active={step === 2} title={t("Elige tu agente Ghosty")}>
          {step === 2 && (
            <div className="space-y-2">
              {/* Las opciones SOLO seleccionan (resaltan). Se crea/conecta en "Continuar". */}
              {(
                [
                  { id: "new:deepseek", sel: { kind: "new", engine: "deepseek" } as Sel, name: t("Crear Ghosty"), sub: t("DeepSeek Flash · rápido") },
                  { id: "new:claude", sel: { kind: "new", engine: "claude" } as Sel, name: t("Crear Ghosty"), sub: t("Claude Sonnet · capaz") },
                ]
              ).map((o) => (
                <button
                  key={o.id}
                  onClick={() => setSel(o.sel)}
                  disabled={!!busy}
                  className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm disabled:opacity-50 ${
                    selId === o.id ? "border-brand bg-brand/15 ring-1 ring-brand" : "border-border bg-surface hover:border-brand"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <img src="/ghosty.svg" alt="" className="h-5 w-5" />
                    <span className="font-medium text-ink">{o.name}</span>
                  </span>
                  <span className="text-xs text-muted">{o.sub}</span>
                </button>
              ))}

              {agents.length > 0 && (
                <p className="pt-2 text-xs text-muted">{t("O usa uno existente:")}</p>
              )}
              {agents.map((a) => (
                <button
                  key={a.id}
                  onClick={() => setSel({ kind: "existing", id: a.id, name: a.name })}
                  disabled={!!busy}
                  className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm disabled:opacity-50 ${
                    selId === a.id ? "border-brand bg-brand/15 ring-1 ring-brand" : "border-border bg-surface hover:border-brand"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <img src="/ghosty.svg" alt="" className="h-5 w-5" />
                    <span className="font-medium text-ink">{a.name}</span>
                  </span>
                  <span className="text-xs text-muted">{a.workerTemplate}</span>
                </button>
              ))}

              {/* Continuar: recién aquí se crea/conecta el agente */}
              <button
                onClick={confirm}
                disabled={!sel || !!busy}
                className="mt-2 w-full rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-brand-fg hover:opacity-90 disabled:opacity-40"
              >
                {busy === "confirm"
                  ? sel?.kind === "new"
                    ? t("Creando…")
                    : t("Conectando…")
                  : sel?.kind === "new"
                    ? t("Crear y continuar →")
                    : t("Continuar →")}
              </button>

              {/* Volver al paso 1 */}
              <button
                onClick={() => goBack("easybits")}
                disabled={!!busy}
                className="pt-1 text-xs text-muted hover:text-brand disabled:opacity-50"
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
              ✅ <span className="font-medium">{shownName || "Ghosty"}</span> {t("conectado.")}
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
