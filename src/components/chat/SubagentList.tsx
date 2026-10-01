// Subagentes del turno, como los muestra Claude Code: una fila VIVA por cada uno con su
// nombre, la tarea que le pidieron, estado, cuántas tools lleva, tokens, reloj y lo último que
// hizo. Clic → el detalle (bitácora y resultado) en el panel lateral.
//
// El reloj lo lleva el CLIENTE desde `startedAt`: el servidor no tiene que repintar el
// mensaje cada segundo para que avance.
import { useContext, useEffect, useState } from "react";
import { Bot, Check, ChevronDown, Square, X } from "lucide-react";
import { useT } from "../../i18n";
import { ThinkingRing } from "../ThinkingRing";
import { ChatCtx } from "./message";
import type { SubagentState } from "../../lib/ebdoc";

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m}:${String(s % 60).padStart(2, "0")}` : `${s}s`;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function SubagentList({ subs, vivo, handle, channelId }: { subs: SubagentState[]; vivo: boolean; handle: string | null; channelId: number | null }) {
  const t = useT();
  const { onOpenArtifact } = useContext(ChatCtx);
  // Un subagente sólo puede seguir corriendo si el turno del padre sigue vivo (misma regla
  // que ToolGroup: la foto guardada a media corrida no puede girar para siempre).
  const view = subs.map((x) => (!vivo && x.status === "running" ? { ...x, status: "done" as const } : x));
  const running = view.filter((x) => x.status === "running").length;
  const now = useNow(running > 0);
  const [open, setOpen] = useState(true);

  const icon = (s: SubagentState["status"]) =>
    s === "running" ? (
      <ThinkingRing size={12} />
    ) : s === "failed" ? (
      <X size={12} className="shrink-0 text-red-500" />
    ) : s === "canceled" ? (
      <Square size={11} className="shrink-0 text-muted" />
    ) : (
      <Check size={12} className="shrink-0 text-emerald-500" />
    );

  return (
    <div className="mb-1.5 max-w-xl overflow-hidden rounded-lg border border-border bg-surface-2/50">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-surface-3/40">
        <Bot size={12} className="shrink-0 text-muted" />
        <span className="font-medium text-ink">
          {view.length} {view.length === 1 ? t("subagente") : t("subagentes")}
        </span>
        {running > 0 && <span className="text-muted">· {running} {t("en curso")}</span>}
        <ChevronDown size={14} className={`ml-auto shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <ul className="border-t border-border/60">
          {view.map((x) => {
            const ms = x.status === "running" ? now - x.startedAt : (x.ms ?? 0);
            const canOpen = !!handle && !!onOpenArtifact;
            return (
              <li key={x.id}>
                <button
                  type="button"
                  disabled={!canOpen}
                  onClick={() => canOpen && onOpenArtifact!({ kind: "subagent", title: x.name, runId: x.id, handle: handle!, channelId, preview: x })}
                  className="flex w-full items-start gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-surface-3/40 disabled:cursor-default"
                  title={x.task}
                >
                  <span className="mt-0.5">{icon(x.status)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-1.5">
                      <span className={`truncate font-semibold ${x.status === "failed" ? "text-red-500" : "text-ink"}`}>{x.name}</span>
                      <span className="shrink-0 font-mono text-[10px] text-muted/80">
                        {x.toolUses} {t("tools")} · {fmtTokens(x.tokens)} {t("tokens")} · {fmtElapsed(ms)}
                      </span>
                    </span>
                    {x.task && x.task !== x.name && <span className="block truncate text-muted">{x.task}</span>}
                    {x.status === "running" && x.last && <span className="block truncate font-mono text-[10px] text-muted/70">⎿ {t(x.last)}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
