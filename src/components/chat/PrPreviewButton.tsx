import { useCallback, useEffect, useState } from "react";
import { prPreviewStatusFn, prPreviewUpFn } from "../../server/apps/pr-preview";
import type { PrPreviewView } from "../../server/apps/pr-preview.server";
import { useT } from "../../i18n";

// «Levantar preview» para un PR SIN pedido de la fábrica (dependabot, personas). El de un pedido
// tiene la suya automática en la caja del pedido y aquí no se pinta nada (el servidor lo dice).
// Mientras construye se pregunta cada 5 s; lista → «Ver preview» con la liga completa (lleva llave).

const WORKING = new Set(["creating", "fetching", "installing", "building", "starting"]);

export function PrPreviewButton({ channelId, repo, number }: { channelId: number; repo: string; number: number }) {
  const t = useT();
  const [v, setV] = useState<PrPreviewView | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const refresh = useCallback(() => {
    if (!channelId) return;
    prPreviewStatusFn({ data: { channelId, repo, number } })
      .then((r) => {
        setV(r);
        setErr("");
      })
      .catch(() => {});
  }, [channelId, repo, number]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const working = !!v?.eligible && WORKING.has(v.phase);
  useEffect(() => {
    if (!working) return;
    const id = setInterval(refresh, 5_000);
    return () => clearInterval(id);
  }, [working, refresh]);

  if (!v?.eligible) return null;

  const up = async () => {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      setV(await prPreviewUpFn({ data: { channelId, repo, number } }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const phaseLabel: Record<string, string> = {
    creating: t("creando la caja…"),
    fetching: t("bajando el código…"),
    installing: t("instalando…"),
    building: t("construyendo…"),
    starting: t("arrancando…"),
  };
  const subtle = "rounded-md border border-border px-2 py-0.5 text-[11px] font-medium text-muted transition hover:bg-surface-3 hover:text-ink disabled:opacity-50";

  return (
    <div className="mt-1 flex max-w-xl flex-wrap items-center gap-1.5">
      {v.phase === "ready" && v.url ? (
        <a href={v.url} target="_blank" rel="noreferrer" className="rounded-md border border-brand px-2 py-0.5 text-[11px] font-medium text-brand transition hover:bg-brand/10">
          {t("Ver preview")}
        </a>
      ) : working ? (
        <span className="text-[11px] text-muted">
          {t("Preview")}: {phaseLabel[v.phase] ?? "…"}
        </span>
      ) : (
        <button type="button" disabled={busy} onClick={up} className={subtle}>
          {busy ? "…" : v.phase === "failed" ? t("Reintentar preview") : t("Levantar preview")}
        </button>
      )}
      {err || (v.phase === "failed" && v.error) ? (
        <span className="min-w-0 flex-1 truncate text-[11px] text-red-500" title={err || v.error || ""}>
          {err || v.error}
        </span>
      ) : null}
    </div>
  );
}
