// Detalle de UN subagente en el panel lateral: tarea completa, contadores, bitácora de pasos
// y su resultado. Mientras corre se relee cada pocos segundos; al terminar, una vez.
import { useCallback, useEffect, useState } from "react";
import { useT } from "../../i18n";
import { Markdown } from "../Markdown";
import { subagentDetailFn, type SubagentDetail } from "../../server/subagents";
import { fmtElapsed, fmtTokens } from "./SubagentList";
import type { SubagentState } from "../../lib/ebdoc";

const STATUS: Record<string, string> = { running: "En curso", done: "Terminó", failed: "Falló", canceled: "Detenido" };

export function SubagentPanel({ runId, handle, preview }: { runId: string; handle: string; preview?: SubagentState }) {
  const t = useT();
  const [d, setD] = useState<SubagentDetail | null>(null);
  const load = useCallback(() => {
    subagentDetailFn({ data: { handle, runId } }).then((r) => r && setD(r)).catch(() => {});
  }, [handle, runId]);
  useEffect(() => {
    load();
  }, [load]);
  const running = (d?.status ?? preview?.status) === "running";
  useEffect(() => {
    if (!running) return;
    const iv = setInterval(load, 4000);
    return () => clearInterval(iv);
  }, [running, load]);

  // Mientras llega el detalle se pinta lo que ya trae la fila (nombre, tarea, contadores).
  const name = d?.name ?? preview?.name ?? t("Subagente");
  const task = d?.task || preview?.task || "";
  const status = d?.status ?? preview?.status ?? "running";
  const toolUses = d?.toolUses ?? preview?.toolUses ?? 0;
  const tokens = d?.tokens ?? preview?.tokens ?? 0;
  const ms = d?.ms ?? preview?.ms ?? (preview?.startedAt ? Date.now() - preview.startedAt : 0);

  return (
    <div className="flex flex-col gap-4 p-4 text-sm">
      <div>
        <h3 className="text-base font-semibold text-ink">{name}</h3>
        <p className="mt-0.5 text-xs text-muted">
          {t(STATUS[status] ?? status)} · {toolUses} {t("tools")} · {fmtTokens(tokens)} {t("tokens")} · {fmtElapsed(ms)}
        </p>
      </div>
      {task && (
        <section>
          <h4 className="mb-1 text-[11px] font-bold uppercase tracking-wide text-muted">{t("Tarea")}</h4>
          <p className="whitespace-pre-wrap text-ink">{task}</p>
        </section>
      )}
      {!!d?.steps.length && (
        <section>
          <h4 className="mb-1 text-[11px] font-bold uppercase tracking-wide text-muted">{t("Pasos")}</h4>
          <ol className="space-y-1 font-mono text-[11px]">
            {d.steps.map((s, i) => (
              <li key={i} className="flex gap-2">
                <span className="shrink-0 text-muted">{s.at ? new Date(s.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : ""}</span>
                <span className="text-ink">{s.tool}</span>
                {s.detail && <span className="truncate text-muted" title={s.detail}>{s.detail}</span>}
              </li>
            ))}
          </ol>
        </section>
      )}
      {(d?.resultMd || preview?.preview) && (
        <section>
          <h4 className="mb-1 text-[11px] font-bold uppercase tracking-wide text-muted">{t("Resultado")}</h4>
          <Markdown body={d?.resultMd ?? preview?.preview ?? ""} />
        </section>
      )}
      {!d && !preview?.preview && status !== "running" && <p className="text-xs text-muted">{t("Sin detalle guardado para este subagente.")}</p>}
    </div>
  );
}
