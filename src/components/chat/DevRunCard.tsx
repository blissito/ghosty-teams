// La tarjeta de un pendiente de gs en el room (una sola fábrica, 22-nov). Es una VISTA del estado que vive en gs: etapa,
// la pregunta del escritor cuando le toca a una persona y botones. Sin chat ni caja de texto dentro (bliss: «chat dentro de
// chat» no): la conversación con el escritor va en el hilo de este mensaje. Molde: el agente de Cursor en Slack.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n";
import { Markdown } from "../Markdown";
import { devThreadActionFn, devThreadCardFn, devThreadTellFn, type DevRunView } from "../../server/apps/dev-threads";

// El apex (no `www`): ahí vive la cookie de sesión de gs.
const STUDIO = "https://ghosty.studio";
const TONE: Record<string, string> = {
  queued: "bg-muted",
  working: "bg-brand",
  waiting_ci: "bg-sky-500",
  reviewing: "bg-violet-500",
  needs_person: "bg-amber-500",
  merging: "bg-emerald-600",
  merged: "bg-emerald-600",
  failed: "bg-red-500",
};

const CHECK_EMOJI = { ok: "✅", running: "🔄", bad: "❌", none: "" } as const;
const CHECK_LABEL = { ci: "CI", review: "Revisión", smoke: "Prueba en vivo", preview: "Vista previa" } as const;

/** ¿La tarjeta está a la vista? Sólo entonces se le pregunta a gs. */
function useVisible(ref: React.RefObject<HTMLElement | null>): boolean {
  const [v, setV] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return setV(true);
    const io = new IntersectionObserver(([e]) => setV(e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return v;
}

// Última vista conocida de cada pendiente: la tarjeta se pinta al instante con ella y gs la actualiza encima.
const CACHE_KEY = (id: string) => `gt-devrun:${id}`;
function cachedView(id: string): (DevRunView & { rootMsgId: number }) | null {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(CACHE_KEY(id)) : null;
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function DevRunCard({ runId }: { runId: string }) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const visible = useVisible(box);
  const [st, setSt] = useState<(DevRunView & { rootMsgId: number }) | null>(() => cachedView(runId));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const load = useCallback(async () => {
    const s = await devThreadCardFn({ data: { runId } }).catch(() => null);
    if (s) {
      setSt(s);
      try {
        localStorage.setItem(CACHE_KEY(runId), JSON.stringify(s));
      } catch {}
    }
  }, [runId]);

  // Mientras se ve: cada 5 s si está viva, nada si ya cerró.
  useEffect(() => {
    if (!visible) return;
    void load();
    if (st && !st.live) return;
    const id = setInterval(() => void load(), 5000);
    return () => clearInterval(id);
  }, [visible, load, st?.live]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!menu) return;
    const close = (e: KeyboardEvent | MouseEvent) => (!(e instanceof KeyboardEvent) || e.key === "Escape") && setMenu(null);
    window.addEventListener("keydown", close);
    window.addEventListener("click", close);
    return () => {
      window.removeEventListener("keydown", close);
      window.removeEventListener("click", close);
    };
  }, [menu]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr("");
    try {
      await fn();
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  if (!st) return <div ref={box} className="mt-2 h-16 max-w-xl animate-pulse rounded-xl border border-border bg-surface-2 motion-reduce:animate-none" />;

  return (
    <div ref={box} className={`mt-2 max-w-xl rounded-xl border border-border shadow-sm ${st.needsPerson ? "bg-amber-50 dark:bg-amber-950/30" : "bg-surface-2"}`}>
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <span className={`h-2 w-2 shrink-0 rounded-full ${TONE[st.phase] ?? "bg-muted"} ${st.phase === "working" ? "animate-pulse motion-reduce:animate-none" : ""}`} />
        {st.issue && <span className="shrink-0 text-[11px] font-bold uppercase tracking-wide text-muted">#{st.issue}</span>}
        <span className="min-w-0 truncate text-sm font-semibold text-ink">{st.title}</span>
        <span className="ml-auto shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted">{t(st.label)}</span>
      </div>
      {st.repo && <p className="px-3 text-xs italic text-muted">{st.repo}</p>}
      {(st.checks?.length ?? 0) > 0 && (
        // La mesa de trabajo de gs (`ficha`): cada pieza con el emoji de su estado; aquí no se calcula nada.
        <p className="flex flex-wrap gap-x-3 gap-y-1 px-3 pt-1 text-xs text-muted">
          {st.checks.map((c) => (
            <span key={c.key}>
              {CHECK_EMOJI[c.state]}{" "}
              {c.key === "preview" && st.previewUrl ? (
                <a href={st.previewUrl} target="_blank" rel="noreferrer" className="underline-offset-2 hover:text-ink hover:underline">
                  {t(CHECK_LABEL[c.key])}
                </a>
              ) : (
                t(CHECK_LABEL[c.key])
              )}
            </span>
          ))}
        </p>
      )}
      {st.needsPerson && (
        <div className="mx-3 mt-2 rounded-lg bg-amber-100 px-2 py-1.5 text-amber-950 dark:bg-amber-900/40 dark:text-amber-50">
          <p className="text-xs font-semibold">{st.idle ? t("El escritor se detuvo sin terminar: dile cómo seguir en el hilo.") : t("Te toca decidir")}</p>
          {st.question && (
            <div className="mt-1 text-sm">
              <Markdown body={st.question} />
            </div>
          )}
          {st.options.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {st.options.map((o) => (
                <button
                  key={o}
                  type="button"
                  disabled={busy}
                  onClick={() => run(() => devThreadTellFn({ data: { runId, text: o } }))}
                  className="rounded-full border border-border bg-surface px-2.5 py-1 text-xs font-semibold text-ink transition hover:border-brand hover:bg-surface-2 disabled:opacity-50"
                >
                  {o}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 px-3 pb-2.5 pt-2">
        {st.canMerge && (
          <button type="button" disabled={busy} onClick={() => run(() => devThreadActionFn({ data: { runId, action: "merge" } }))} className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-bold text-white hover:opacity-90 disabled:opacity-50">
            {t("Mezclar")}
          </button>
        )}
        <a href={`?thread=${st.rootMsgId}`} className="rounded-lg border border-border px-3 py-1.5 text-xs font-bold text-ink hover:bg-surface">
          💬 {t("Ver conversación")}
        </a>
        {st.prUrl && (
          <a href={st.prUrl} target="_blank" rel="noreferrer" className={`rounded-lg px-3 py-1.5 text-xs font-bold ${st.canMerge ? "border border-border text-ink" : "bg-emerald-700 text-white"}`}>
            {t("Ver PR")}
          </a>
        )}
        <a href={`${STUDIO}/c/dev/${encodeURIComponent(runId)}`} target="_blank" rel="noreferrer" className="rounded-lg border border-border px-3 py-1.5 text-xs font-bold text-ink hover:bg-surface">
          {t("Abrir en Ghosty")}
        </a>
        {st.live && st.phase !== "merging" && (
          <button
            type="button"
            aria-label={t("Más acciones")}
            onClick={(e) => {
              e.stopPropagation();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setMenu({ x: r.left, y: r.bottom + 4 });
            }}
            className="rounded-lg border border-border px-2.5 py-1.5 text-xs font-bold text-ink hover:bg-surface"
          >
            ⋯
          </button>
        )}
        {err && <span className="text-xs text-red-600">{err}</span>}
      </div>
      {menu &&
        createPortal(
          <div style={{ position: "fixed", left: menu.x, top: menu.y }} className="z-50 min-w-40 rounded-lg border border-border bg-surface py-1 text-sm shadow-lg" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="block w-full px-3 py-1.5 text-left text-red-600 hover:bg-surface-2"
              onClick={() => {
                setMenu(null);
                void run(() => devThreadActionFn({ data: { runId, action: "stop" } }));
              }}
            >
              {t("Detener el pendiente")}
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
