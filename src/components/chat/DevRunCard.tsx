// La tarjeta de un pendiente de gs en el room (una sola fábrica, 22-nov). Es una VISTA: la conversación, la etapa y el PR
// viven en gs y se leen en vivo mientras la tarjeta está a la vista; nada se copia a Teams. Lo que se escribe en su
// composer le llega al escritor por `op:tell`. Molde: el agente de Cursor en Slack (un mensaje con estado, resumen del
// agente con «Ver más» y botones «Ver PR» / «Abrir en …» / «⋯»).
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n";
import { Markdown } from "../Markdown";
import { devThreadActionFn, devThreadCardFn, devThreadConversationFn, devThreadTellFn, type DevChatMessage, type DevRunView } from "../../server/apps/dev-threads";

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

export function DevRunCard({ runId }: { runId: string }) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const visible = useVisible(box);
  const [st, setSt] = useState<(DevRunView & { rootMsgId: number }) | null>(null);
  const [msgs, setMsgs] = useState<DevChatMessage[]>([]);
  const lastSeq = useRef(0);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const load = useCallback(async () => {
    const [s, c] = await Promise.all([
      devThreadCardFn({ data: { runId } }).catch(() => null),
      devThreadConversationFn({ data: { runId, after: lastSeq.current } }).catch(() => null),
    ]);
    if (s) setSt(s);
    if (c?.messages.length) {
      lastSeq.current = Math.max(lastSeq.current, ...c.messages.map((m) => m.seq));
      setMsgs((prev) => {
        const seen = new Set(prev.map((m) => m.seq));
        return [...prev, ...c.messages.filter((m) => !seen.has(m.seq))];
      });
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
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    void run(async () => {
      await devThreadTellFn({ data: { runId, text } });
      setDraft("");
      setOpen(true);
    });
  };

  if (!st) return <div ref={box} className="mt-2 h-16 max-w-xl animate-pulse rounded-xl border border-border bg-surface-2 motion-reduce:animate-none" />;

  const writer = msgs.filter((m) => m.role === "writer");
  const last = writer[writer.length - 1];
  const shown = open ? msgs : last && last.text !== st.question ? [last] : [];

  return (
    <div ref={box} className={`mt-2 max-w-xl rounded-xl border border-border shadow-sm ${st.needsPerson ? "bg-amber-50 dark:bg-amber-950/30" : "bg-surface-2"}`}>
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <span className={`h-2 w-2 shrink-0 rounded-full ${TONE[st.phase] ?? "bg-muted"} ${st.phase === "working" ? "animate-pulse motion-reduce:animate-none" : ""}`} />
        {st.issue && <span className="shrink-0 text-[11px] font-bold uppercase tracking-wide text-muted">#{st.issue}</span>}
        <span className="min-w-0 truncate text-sm font-semibold text-ink">{st.title}</span>
        <span className="ml-auto shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted">{t(st.label)}</span>
      </div>
      {st.repo && <p className="px-3 text-xs italic text-muted">{st.repo}</p>}
      {st.needsPerson && (
        <div className="mx-3 mt-2 rounded-lg bg-amber-100 px-2 py-1.5 text-amber-950 dark:bg-amber-900/40 dark:text-amber-50">
          <p className="text-xs font-semibold">{t("Te toca decidir")}</p>
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
                  className="rounded-full border border-amber-400 bg-white/70 px-2.5 py-1 text-xs font-semibold hover:bg-white disabled:opacity-50 dark:bg-amber-950/40"
                >
                  {o}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {shown.length > 0 && (
        <div className={`mx-3 mt-2 space-y-2 ${open ? "max-h-80 overflow-y-auto pr-1" : ""}`}>
          {shown.map((m) => (
            <div key={m.seq} className={m.role === "person" ? "ml-8 rounded-lg bg-surface px-2 py-1 text-sm" : "text-sm"}>
              <div className={open ? "" : "line-clamp-4"}>
                <Markdown body={m.text} />
              </div>
            </div>
          ))}
        </div>
      )}
      {msgs.length > 1 && (
        <button type="button" onClick={() => setOpen((o) => !o)} className="mx-3 mt-1 text-xs font-semibold text-brand hover:underline">
          {open ? t("Ver menos") : `${t("Ver conversación")} (${msgs.length})`}
        </button>
      )}

      {st.live && (
        <div className="mx-3 mt-2 flex items-center gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), send())}
            placeholder={t("Escríbele al escritor…")}
            className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-brand"
          />
          <button type="button" disabled={busy || !draft.trim()} onClick={send} className="shrink-0 rounded-lg bg-brand px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50">
            {t("Enviar")}
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 px-3 pb-2.5 pt-2">
        {st.canMerge && (
          <button type="button" disabled={busy} onClick={() => run(() => devThreadActionFn({ data: { runId, action: "merge" } }))} className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-bold text-white hover:opacity-90 disabled:opacity-50">
            {t("Mezclar")}
          </button>
        )}
        {st.prUrl && (
          <a href={st.prUrl} target="_blank" rel="noreferrer" className={`rounded-lg px-3 py-1.5 text-xs font-bold ${st.canMerge ? "border border-border text-ink" : "bg-emerald-700 text-white"}`}>
            {t("Ver PR")}
          </a>
        )}
        <a href={`${STUDIO}/c/desarrollo/${encodeURIComponent(runId)}`} target="_blank" rel="noreferrer" className="rounded-lg border border-border px-3 py-1.5 text-xs font-bold text-ink hover:bg-surface">
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
