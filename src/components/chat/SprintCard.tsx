// Tarjeta del sprint (```gt-sprint```): el mismo lugar pasa de BORRADOR a PROGRESO.
//  - Borrador: la épica y sus tickets en orden (tamaño, «tras #n», criterios plegados); un
//    interruptor por ticket para dejarlo fuera, título editable, «Pedir cambios» y un solo
//    «Crear sprint · N tickets» (aprobar el sprint aprueba el plan de cada ticket).
//  - Activo: una fila por ticket con su estado y ligas al pedido y al PR; un ticket cuyo PR se
//    cerró sin merge pide decisión (reintentar o quitar).
//  - Terminado: morado «merged», como todo lo mezclado.
// Lee su estado de la base (el fence sólo trae el id) y se refresca con los `refresh` del room.
import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, Loader2, Pencil } from "lucide-react";
import { useT } from "../../i18n";
import { useRtSubscribe } from "../../utils/rt-bus";
import { Toggle } from "../Toggle";
import {
  factorySprintApproveFn,
  factorySprintChangesFn,
  factorySprintEditFn,
  factorySprintFn,
  factorySprintItemFn,
  type SprintView,
} from "../../server/apps/factory";

const STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: "En cola", cls: "bg-surface-3 text-muted" },
  active: { label: "Trabajando", cls: "bg-brand/15 text-brand" },
  pr: { label: "PR", cls: "bg-emerald-600/15 text-emerald-700 dark:text-emerald-400" },
  merged: { label: "Merged", cls: "bg-violet-600/15 text-violet-700 dark:text-violet-300" },
  failed: { label: "Necesita decisión", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  skipped: { label: "Quitado", cls: "bg-surface-3 text-muted line-through" },
};

export function SprintCard({ card, channelId }: { card: { sprintId: number }; channelId: number }) {
  const t = useT();
  const [st, setSt] = useState<SprintView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [editing, setEditing] = useState<{ id: number; title: string } | null>(null);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [sent, setSent] = useState(false);
  // Llegó una versión nueva del borrador: se puede volver a pedir cambios.
  const version = st?.version;
  useEffect(() => setSent(false), [version]);

  const refresh = useCallback(() => {
    factorySprintFn({ data: { sprintId: card.sprintId } }).then(setSt).catch(() => {});
  }, [card.sprintId]);
  useEffect(() => refresh(), [refresh]);
  useRtSubscribe({
    onEvent: (ev) => {
      if (ev.t === "refresh" && ev.channelId === channelId) refresh();
    },
  });
  if (!st) return null;

  const run = async (key: string, fn: () => Promise<SprintView | { ok: true } | null>) => {
    setBusy(key);
    setErr("");
    try {
      const r = await fn();
      if (r && "items" in r) setSt(r);
      else refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const draft = st.status === "draft";
  const done = st.status === "done";
  const included = st.items.filter((i) => i.included);
  const merged = included.filter((i) => i.status === "merged" || i.status === "skipped").length;
  const byKey = new Map(st.items.map((i) => [i.key, i]));

  return (
    <div className="mt-1.5 max-w-xl overflow-hidden rounded-lg gt-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-[11px] font-bold uppercase tracking-wide text-ink">🧩 {t("Sprint")}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{st.title}</span>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
            draft ? "bg-amber-500/15 text-amber-700 dark:text-amber-400" : done ? STATUS.merged.cls : "bg-brand/15 text-brand"
          }`}
        >
          {draft ? t("Borrador") : done ? t("Terminado") : `${merged}/${included.length}`}
        </span>
      </div>
      <div className="p-3">
        <p className="text-xs text-muted">
          {st.goal}
          {st.repo && <span className="ml-1.5 font-mono">· {st.repo}</span>}
        </p>
        {!draft && (
          <div className="mt-2 flex gap-1" role="img" aria-label={`${merged} / ${included.length}`}>
            {included.map((i) => (
              <div key={i.id} className={`h-1.5 flex-1 rounded-full ${i.status === "merged" || i.status === "skipped" ? "bg-violet-500" : i.status === "pr" ? "bg-emerald-500" : i.status === "active" ? "bg-brand" : "bg-surface-3"}`} />
            ))}
          </div>
        )}
        <ol className="mt-2 divide-y divide-border rounded-md border border-border">
          {st.items.map((i) => {
            const deps = i.dependsOn.map((d) => byKey.get(d)?.idx).filter(Boolean);
            const s = STATUS[i.status] ?? STATUS.pending;
            return (
              <li key={i.id} className={`px-2.5 py-2 ${!i.included ? "opacity-50" : ""}`}>
                <div className="flex items-center gap-2">
                  <span className="w-5 shrink-0 text-right font-mono text-[11px] text-muted">{i.idx}</span>
                  <span className="shrink-0 rounded border border-border px-1 font-mono text-[10px] text-muted" title={t("Tamaño (S ≤ 1 h, M ≤ 2 h, L ≤ 3 h de agente)")}>
                    {i.size}
                  </span>
                  {editing?.id === i.id ? (
                    <input
                      value={editing.title}
                      onChange={(e) => setEditing({ id: i.id, title: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && editing.title.trim())
                          void run(`t${i.id}`, () => factorySprintEditFn({ data: { sprintId: st.id, itemId: i.id, title: editing.title } })).then(() => setEditing(null));
                        if (e.key === "Escape") setEditing(null);
                      }}
                      className="min-w-0 flex-1 rounded border border-border bg-surface px-1.5 py-0.5 text-sm text-ink"
                      autoFocus
                    />
                  ) : (
                    <button type="button" onClick={() => setOpen(open === i.id ? null : i.id)} className="flex min-w-0 flex-1 items-center gap-1 text-left">
                      <span className="truncate text-sm text-ink">{i.title}</span>
                      <ChevronDown size={12} className={`shrink-0 text-muted transition-transform ${open === i.id ? "rotate-180" : ""}`} />
                    </button>
                  )}
                  {deps.length > 0 && <span className="shrink-0 text-[11px] text-muted">{t("tras")} #{deps.join(", #")}</span>}
                  {draft && st.canEdit ? (
                    <>
                      {editing?.id !== i.id && (
                        <button type="button" onClick={() => setEditing({ id: i.id, title: i.title })} aria-label={t("Editar título")} className="shrink-0 rounded p-0.5 text-muted hover:text-ink">
                          <Pencil size={12} />
                        </button>
                      )}
                      <Toggle
                        on={i.included}
                        disabled={!!busy}
                        label={`${i.title}: ${i.included ? t("incluido") : t("fuera")}`}
                        onChange={(on) => void run(`i${i.id}`, () => factorySprintEditFn({ data: { sprintId: st.id, itemId: i.id, included: on } }))}
                      />
                    </>
                  ) : !draft && i.included ? (
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${s.cls}`}>{t(s.label)}</span>
                  ) : null}
                </div>
                {!draft && (i.threadUrl || i.prUrl) && (
                  <div className="mt-1 flex gap-3 pl-7 text-[11px]">
                    {i.threadUrl && <a href={i.threadUrl} className="text-brand hover:underline">{t("Pedido")} →</a>}
                    {i.prUrl && <a href={i.prUrl} target="_blank" rel="noreferrer" className="text-muted hover:text-ink">PR ↗</a>}
                  </div>
                )}
                {!draft && i.status === "failed" && st.canEdit && (
                  <div className="mt-1.5 flex gap-2 pl-7">
                    <button type="button" disabled={!!busy} onClick={() => void run(`r${i.id}`, () => factorySprintItemFn({ data: { sprintId: st.id, itemId: i.id, action: "retry" } }))} className="rounded-md border border-brand px-2 py-0.5 text-[11px] font-semibold text-brand hover:bg-brand/10 disabled:opacity-50">
                      {t("Reintentar")}
                    </button>
                    <button type="button" disabled={!!busy} onClick={() => void run(`s${i.id}`, () => factorySprintItemFn({ data: { sprintId: st.id, itemId: i.id, action: "skip" } }))} className="rounded-md border border-border px-2 py-0.5 text-[11px] font-semibold text-muted hover:text-ink disabled:opacity-50">
                      {t("Quitar del sprint")}
                    </button>
                  </div>
                )}
                {open === i.id && <p className="mt-1.5 whitespace-pre-wrap pl-7 text-[11.5px] leading-relaxed text-muted">{i.bodyMd.replace(/^# .*\n+/, "")}</p>}
              </li>
            );
          })}
        </ol>

        {draft && st.canEdit && (
          <div className="mt-3">
            <button
              type="button"
              disabled={!!busy || included.length === 0}
              onClick={() => void run("approve", () => factorySprintApproveFn({ data: { sprintId: st.id } }))}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-brand-fg hover:opacity-90 disabled:opacity-60"
            >
              {busy === "approve" ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              {t("Crear sprint")} · {included.length} {included.length === 1 ? t("ticket") : t("tickets")}
            </button>
            <p className="mt-1 text-center text-[11px] text-muted">{t("Una sola aprobación: cada ticket se construye en orden, @check revisa y tú haces merge.")}</p>
            {!asking ? (
              <button type="button" onClick={() => setAsking(true)} disabled={sent} className="mx-auto mt-1 block text-xs text-muted hover:text-ink disabled:opacity-60">
                {sent ? t("@plan está rehaciendo el sprint…") : t("Pedir cambios")}
              </button>
            ) : (
              <div className="mt-2 flex gap-2">
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && note.trim() && void send()}
                  placeholder={t("¿Qué cambiarías?")}
                  className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-ink"
                  autoFocus
                />
                <button type="button" disabled={!note.trim() || !!busy} onClick={() => void send()} className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
                  {t("Enviar")}
                </button>
              </div>
            )}
          </div>
        )}
        {draft && !st.canEdit && <p className="mt-2 text-xs text-muted">{t("Lo aprueba el dueño del espacio o quien lo pidió.")}</p>}
        {done && (
          <p className="mt-2 rounded-md bg-violet-600/10 px-2.5 py-1.5 text-xs font-semibold text-violet-700 dark:text-violet-300">🎉 {t("Sprint terminado: todos los tickets con merge.")}</p>
        )}
        {err && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{err}</p>}
      </div>
    </div>
  );

  async function send() {
    await run("changes", () => factorySprintChangesFn({ data: { sprintId: st!.id, note } }));
    setAsking(false);
    setNote("");
    setSent(true);
  }
}
