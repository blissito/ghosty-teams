// Tarjeta del sprint (```gt-sprint```): el mismo lugar pasa de BORRADOR a PROGRESO.
//  - Borrador: la épica y sus tickets en orden (tamaño, «tras #n», criterios plegados); un
//    interruptor por ticket para dejarlo fuera, título editable, «Pedir cambios» y un solo
//    «Crear sprint · N tickets» (aprobar el sprint aprueba el plan de cada ticket).
//  - Activo: una fila por ticket con su estado y ligas al pedido y al PR; un ticket cuyo PR se
//    cerró sin merge pide decisión (reintentar o quitar).
//  - Terminado: morado «merged», como todo lo mezclado.
// Lee su estado de la base (el fence sólo trae el id) y se refresca con los `refresh` del room.
import { useCallback, useContext, useEffect, useState } from "react";
import { ChatCtx } from "./message";
import { Check, ChevronDown, Loader2, Pencil } from "lucide-react";
import { useT } from "../../i18n";
import { useRtSubscribe } from "../../utils/rt-bus";
import { Toggle } from "../Toggle";
import { Markdown } from "../Markdown";
import {
  factorySprintApproveFn,
  factorySprintChangesFn,
  factorySprintEditFn,
  factorySprintFn,
  factorySprintItemFn,
  factorySprintIssueFn,
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

/**
 * La MISMA tarjeta en el hilo y en el panel lateral (`expanded`): tickets, interruptores,
 * títulos, criterios, «Dejar como issue» y «Pedir cambios» se usan sin salir de la
 * conversación. En el hilo suma «Ver sprint» para abrirla en grande. Una versión compacta
 * (01-oct) y luego una de sólo lectura (14-oct) obligaban a abrir el panel para decidir.
 */
export function SprintCard({ card, channelId, expanded = false }: { card: { sprintId: number }; channelId: number; expanded?: boolean }) {
  const t = useT();
  const { onOpenArtifact } = useContext(ChatCtx);
  const [st, setSt] = useState<SprintView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [editing, setEditing] = useState<{ id: number; title: string } | null>(null);
  // Cuerpo en edición: se edita SIN el renglón `# título` (ése es el título de arriba) y se
  // vuelve a anteponer al guardar.
  const [editingBody, setEditingBody] = useState<{ id: number; head: string; body: string } | null>(null);
  // Dónde está abierta la nota de «Pedir cambios»: al sprint completo o junto a un ticket
  // (se abre AHÍ, no al fondo de la tarjeta, para que se vea qué se está pidiendo).
  const [asking, setAsking] = useState<"sprint" | number | null>(null);
  const [note, setNote] = useState("");
  // La nota pendiente sale del SERVIDOR (`change.pending`): sobrevive a recargas y la ve todo
  // el room. Se enseña arriba con contador hasta que Arqui entrega la versión nueva.
  const sent = st?.change?.pending ? st.change.note : null;
  const sentAt = (st?.change?.at ?? 0) * 1000;
  const [now, setNow] = useState(() => Date.now());
  // Se cerró el aviso «v{N} · por la nota de …» de esta versión.
  const [seenVersion, setSeenVersion] = useState<number | null>(null);
  // Reloj del aviso: rehacer un sprint son minutos (Arqui relee el repo); sin un contador el
  // spinner parece colgado.
  useEffect(() => {
    if (!sent) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [sent]);

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
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const draft = st.status === "draft";
  const done = st.status === "done";
  const included = st.items.filter((i) => i.included);
  const merged = included.filter((i) => i.status === "merged" || i.status === "skipped").length;
  const byKey = new Map(st.items.map((i) => [i.key, i]));
  const working = included.filter((i) => i.status === "active" || i.status === "pr").length;
  const current = included.find((i) => i.status === "active" || i.status === "pr");
  const stageLabel = (s: string | null) =>
    s === "you_review" ? t("te toca revisar el PR") : s === "you_decide" ? t("te toca decidir") : s === "box_wait" ? t("en espera de caja") : (s ?? "");
  const openPanel = () => onOpenArtifact?.({ kind: "sprint", title: st.title, sprintId: st.id, channelId });

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
        {!expanded && (
          <button type="button" onClick={openPanel} className="shrink-0 rounded-full border border-border px-2.5 py-0.5 text-[11px] font-semibold text-muted hover:text-ink">
            {t("Ver sprint")}
          </button>
        )}
      </div>
      <div className="p-3">
        <p className="text-xs text-muted">
          {st.goal}
          {st.repo && <span className="ml-1.5 font-mono">· {st.repo}</span>}
        </p>
        {draft && sent && (
          <div className="mt-2 flex items-start gap-2 rounded-md bg-brand/10 px-2.5 py-2 text-xs text-ink" role="status">
            <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin text-brand" />
            <span className="min-w-0">
              <span className="font-semibold">{t("Arqui está rehaciendo el sprint con tu nota")}</span>
              <span className="ml-1.5 font-mono text-muted">{fmtElapsed(now - sentAt)}</span>
              <span className="block truncate text-muted">«{sent}»</span>
              <span className="block text-[11px] text-muted">
                {now - sentAt > 8 * 60_000
                  ? t("Está tardando más de lo normal: revisa la respuesta de Arqui en el hilo.")
                  : t("Relee el repo y vuelve a armar los tickets; suele tomar unos minutos. Su avance se ve en el hilo.")}
              </span>
              {st.threadUrl && (
                <a href={st.threadUrl} className="mt-0.5 inline-block text-[11px] font-semibold text-brand hover:underline">
                  {t("Ver en el hilo")} →
                </a>
              )}
            </span>
          </div>
        )}
        {draft && !sent && st.change?.answered && st.diff && seenVersion !== st.version && (
          <div className="mt-2 rounded-md border border-border px-2.5 py-2 text-xs text-ink" role="status">
            <div className="flex items-start gap-2">
              <span className="min-w-0 flex-1">
                <span className="font-semibold">
                  v{st.version} · {t("por la nota de")} {st.change.byName ?? t("alguien")}
                </span>
                <span className="block truncate text-muted">«{st.change.note}»</span>
                <span className="mt-0.5 block text-[11px] text-muted">
                  {st.diff.added.length + st.diff.changed.length + st.diff.removed.length === 0
                    ? t("Sin cambios en los tickets.")
                    : [
                        st.diff.added.length ? `${st.diff.added.length} ${t("nuevos")}` : "",
                        st.diff.changed.length ? `${st.diff.changed.length} ${t("cambiaron")}` : "",
                        st.diff.removed.length ? `${t("salieron")}: ${st.diff.removed.map((r) => r.title).join(", ")}` : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                </span>
              </span>
              <button type="button" onClick={() => setSeenVersion(st.version)} aria-label={t("Cerrar")} className="shrink-0 text-muted hover:text-ink">
                ×
              </button>
            </div>
          </div>
        )}
        {!draft && (
          <div className="mt-2 flex gap-1" role="img" aria-label={`${merged} / ${included.length}`}>
            {included.map((i) => (
              <div key={i.id} className={`h-1.5 flex-1 rounded-full ${i.status === "merged" || i.status === "skipped" ? "bg-violet-500" : i.status === "pr" ? "bg-emerald-500" : i.status === "active" ? "bg-brand" : "bg-surface-3"}`} />
            ))}
          </div>
        )}
        {!draft && !done && current && (
          <p className="mt-1.5 truncate text-xs text-ink">
            <span className="text-muted">{t("Ahora")}:</span> #{current.idx} {current.title}
            {current.stage && <span className="font-semibold"> · {stageLabel(current.stage)}</span>}
            {working > 1 && <span className="text-muted"> · {working} {t("en curso")}</span>}
          </p>
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
                      {draft && st.diff && seenVersion !== st.version && (st.diff.added.includes(i.key) || st.diff.changed.includes(i.key)) && (
                        <span className="shrink-0 rounded-full bg-brand/15 px-1.5 text-[10px] font-semibold text-brand">
                          {st.diff.added.includes(i.key) ? t("nuevo") : t("cambió")}
                        </span>
                      )}
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
                  ) : !draft && !i.included && st.canEdit && st.status !== "cancelled" ? (
                    // Lo que quedó fuera al aprobar se puede sumar después: arranca solo cuando sus
                    // dependencias tengan merge.
                    <button
                      type="button"
                      disabled={!!busy}
                      onClick={() => void run(`i${i.id}`, () => factorySprintEditFn({ data: { sprintId: st.id, itemId: i.id, included: true } }))}
                      className="shrink-0 rounded-full border border-brand px-2 py-0.5 text-[11px] font-semibold text-brand hover:bg-brand/10 disabled:opacity-50"
                    >
                      {busy === `i${i.id}` ? <Loader2 size={11} className="animate-spin" /> : t("Incluir")}
                    </button>
                  ) : null}
                </div>
                {((!draft && (i.threadUrl || i.prUrl)) || i.issueUrl || (!i.included && st.canEdit && st.repo && st.status !== "cancelled")) && (
                  <div className="mt-1 flex gap-3 pl-7 text-[11px]">
                    {!draft && i.threadUrl && <a href={i.threadUrl} className="text-brand hover:underline">{t("Pedido")} →</a>}
                    {!draft && i.prUrl && <a href={i.prUrl} target="_blank" rel="noreferrer" className="text-muted hover:text-ink">PR ↗</a>}
                    {i.issueUrl ? (
                      <a href={i.issueUrl} target="_blank" rel="noreferrer" className="text-muted hover:text-ink">
                        {t("Issue")} #{i.issueNumber} ↗
                      </a>
                    ) : !i.included && st.canEdit && st.repo && st.status !== "cancelled" ? (
                      // Lo que no entra hoy queda en GitHub para después; si luego se construye, su PR lo cierra.
                      <button
                        type="button"
                        disabled={!!busy}
                        onClick={() => void run(`g${i.id}`, () => factorySprintIssueFn({ data: { sprintId: st.id, itemId: i.id } }))}
                        className="font-semibold text-brand hover:underline disabled:opacity-50"
                      >
                        {busy === `g${i.id}` ? <Loader2 size={11} className="animate-spin" /> : t("Dejar como issue")}
                      </button>
                    ) : null}
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
                {open === i.id && editingBody?.id === i.id ? (
                  <div className="mt-1.5 pl-7">
                    <textarea
                      value={editingBody.body}
                      onChange={(e) => setEditingBody({ ...editingBody, body: e.target.value })}
                      onKeyDown={(e) => e.key === "Escape" && setEditingBody(null)}
                      rows={Math.min(18, Math.max(6, editingBody.body.split("\n").length + 1))}
                      className="w-full rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-[11.5px] leading-relaxed text-ink"
                      autoFocus
                    />
                    <div className="mt-1 flex items-center gap-2">
                      <button
                        type="button"
                        disabled={!!busy || !editingBody.body.trim()}
                        onClick={() =>
                          void run(`b${i.id}`, () =>
                            factorySprintEditFn({ data: { sprintId: st.id, itemId: i.id, bodyMd: `${editingBody.head}${editingBody.body.trim()}` } })
                          ).then(() => setEditingBody(null))
                        }
                        className="rounded-md bg-brand px-2.5 py-1 text-[11px] font-semibold text-brand-fg disabled:opacity-50"
                      >
                        {busy === `b${i.id}` ? <Loader2 size={11} className="animate-spin" /> : t("Guardar")}
                      </button>
                      <button type="button" onClick={() => setEditingBody(null)} className="text-[11px] text-muted hover:text-ink">
                        {t("Cancelar")}
                      </button>
                      <span className="ml-auto text-[10px] text-muted">{t("Markdown · Esc para cancelar")}</span>
                    </div>
                  </div>
                ) : open === i.id ? (
                  <div className="mt-1.5 pl-7">
                    {/* Renderizado, no crudo: el cuerpo trae ## secciones, listas y `código`. */}
                    <div className="gt-plan text-[11.5px] leading-relaxed text-muted [&_h2]:mt-2 [&_h2]:text-[12px] [&_h2]:font-semibold [&_h2]:text-ink">
                      <Markdown body={i.bodyMd.replace(/^# .*\n+/, "")} />
                    </div>
                    {draft && st.canEdit && (
                      <div className="mt-1.5 flex gap-3 text-[11px]">
                        <button
                          type="button"
                          onClick={() => {
                            const head = i.bodyMd.match(/^# .*\n+/)?.[0] ?? "";
                            setEditingBody({ id: i.id, head, body: i.bodyMd.slice(head.length) });
                          }}
                          className="inline-flex items-center gap-1 font-semibold text-brand hover:underline"
                        >
                          <Pencil size={11} /> {t("Editar ticket")}
                        </button>
                        {/* Preferencias o correcciones que prefieres que Arqui aplique (y propague a
                            los demás tickets) en vez de escribirlas tú: abre «Pedir cambios» ya
                            apuntando a este ticket. */}
                        <button
                          type="button"
                          disabled={!!sent}
                          onClick={() => {
                            setNote(`#${i.idx} «${i.title}»: `);
                            setAsking(i.id);
                          }}
                          className="text-muted hover:text-ink disabled:opacity-50"
                        >
                          {sent ? t("Cambios enviados ✓") : t("Pedir cambios a este ticket")}
                        </button>
                      </div>
                    )}
                    {asking === i.id && noteBox()}
                  </div>
                ) : null}
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
            {asking !== "sprint" ? (
              <button
                type="button"
                onClick={() => {
                  setNote("");
                  setAsking("sprint");
                }}
                disabled={!!sent}
                className="mx-auto mt-1 block text-xs text-muted hover:text-ink disabled:opacity-60"
              >
                {sent ? t("Arqui está rehaciendo el sprint…") : t("Pedir cambios")}
              </button>
            ) : (
              noteBox()
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

  function noteBox() {
    const sending = busy === "changes";
    return (
      <div className="mt-2 flex gap-2">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && note.trim() && !sending) void send();
            if (e.key === "Escape") setAsking(null);
          }}
          placeholder={t("¿Qué cambiarías?")}
          disabled={sending}
          className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-ink disabled:opacity-60"
          autoFocus
        />
        <button
          type="button"
          disabled={!note.trim() || !!busy}
          onClick={() => void send()}
          className="inline-flex items-center gap-1 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
        >
          {sending && <Loader2 size={12} className="animate-spin" />}
          {sending ? t("Enviando…") : t("Enviar")}
        </button>
      </div>
    );
  }

  async function send() {
    const text = note.trim();
    const ok = await run("changes", () => factorySprintChangesFn({ data: { sprintId: st!.id, note: text } }));
    if (!ok) return; // el error ya se ve abajo; la nota se queda para reintentar
    setAsking(null);
    setNote("");
    setNow(Date.now());
  }
}

function fmtElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}
