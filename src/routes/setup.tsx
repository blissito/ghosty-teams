import { createFileRoute, useRouter, Link, redirect } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { getSetup, selectFleetAgent, createFleetAgent, disconnectSetup } from "../server/setup";
import { listFormmyAgentsFn, connectFormmyAgentFn, type FormmyAgent } from "../server/formmy-agents";
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
  const [err, setErr] = useState<string | null>(null);
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
  // Sel = motor nuevo { kind:"new" } | agente de flota existente { kind:"existing" }
  //     | Agent de Formmy { kind:"formmy" } (asegura su espejo en la flota al conectar).
  type Sel =
    | { kind: "new"; engine: "deepseek" | "claude" }
    | { kind: "existing"; id: string; name: string }
    | { kind: "formmy"; id: string; name: string };
  const [sel, setSel] = useState<Sel | null>(null);
  const selId =
    sel?.kind === "new"
      ? `new:${sel.engine}`
      : sel?.kind === "formmy"
        ? `formmy:${sel.id}`
        : sel?.kind === "existing"
          ? sel.id
          : null;

  // Agents de Formmy del owner (el "agente de verdad" es su espejo en la flota).
  // Carga best-effort; degrada a [] si el puente falla → no bloquea el wizard.
  const [formmyAgents, setFormmyAgents] = useState<FormmyAgent[]>([]);
  useEffect(() => {
    if (step !== 2) return;
    listFormmyAgentsFn().then(setFormmyAgents).catch(() => setFormmyAgents([]));
  }, [step]);

  // Confirmar la selección: recién aquí se CREA (motor nuevo), se conecta (flota) o se
  // asegura el espejo del Agent de Formmy.
  async function confirm() {
    if (!sel) return;
    setBusy("confirm");
    setErr(null);
    try {
      if (sel.kind === "new") {
        await createFleetAgent({ data: { engine: sel.engine } });
      } else if (sel.kind === "formmy") {
        const r = await connectFormmyAgentFn({ data: { agentId: sel.id, name: sel.name } });
        if (!r.ok) throw new Error("401");
      } else {
        await selectFleetAgent({ data: { id: sel.id } });
      }
      // Listo → directo al chat (la pantalla de "conectado · Ir al chat" sobra). NO
      // reseteamos busy: seguimos navegando fuera del wizard, el botón queda deshabilitado
      // hasta que se desmonta. (OJO: un `finally { setBusy(null) }` corre AUNQUE haya
      // return → re-habilitaba el botón antes de navegar. Por eso el reset va SOLO en error.)
      router.navigate({ to: "/c/$slug", params: { slug: "general" } });
    } catch (e) {
      // Error visible + re-habilitar (antes el try/finally sin catch lo perdía). Un
      // 401/Unauthorized = token EasyBits expirado → reconectar.
      const msg = e instanceof Error ? e.message : String(e);
      setErr(
        /401|unauthorized/i.test(msg)
          ? t("Tu conexión con EasyBits expiró. Reconéctala abajo (← Desconectar EasyBits) y vuelve a intentar.")
          : t("No se pudo crear el agente: {msg}", { msg })
      );
      setBusy(null); // solo en error re-habilitamos; en éxito navegamos (se desmonta)
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
    <div className="grid min-h-[100dvh] place-items-center bg-surface text-ink pl-[max(1.5rem,env(safe-area-inset-left))] pr-[max(1.5rem,env(safe-area-inset-right))] pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
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
                onClick={() => setBusy("connect")}
                aria-disabled={busy === "connect"}
                className={`inline-block rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-brand-fg hover:opacity-90 ${
                  busy === "connect" ? "pointer-events-none opacity-60" : ""
                }`}
              >
                {busy === "connect" ? t("Conectando…") : t("Conectar EasyBits")}
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

              {/* Agents de Formmy del owner: conectarlos asegura su espejo en la flota
                  (el "agente de verdad" donde corre la inferencia en la microVM). */}
              {formmyAgents.length > 0 && (
                <p className="pt-2 text-xs text-muted">{t("O uno de tus agentes de Formmy:")}</p>
              )}
              {formmyAgents.map((a) => (
                <button
                  key={`formmy:${a.id}`}
                  onClick={() => setSel({ kind: "formmy", id: a.id, name: a.name })}
                  disabled={!!busy}
                  className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm disabled:opacity-50 ${
                    selId === `formmy:${a.id}` ? "border-brand bg-brand/15 ring-1 ring-brand" : "border-border bg-surface hover:border-brand"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <img src="/ghosty.svg" alt="" className="h-5 w-5" />
                    <span className="font-medium text-ink">{a.name}</span>
                  </span>
                  <span className="text-xs text-muted">
                    {a.hasFleetMirror ? t("en la flota") : t("Formmy")}
                  </span>
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

              {err && (
                <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">{err}</p>
              )}

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
