import { useCallback, useEffect, useState } from "react";
import { prPreviewStatusFn } from "../../server/apps/pr-preview";
import type { PrPreviewView } from "../../server/apps/pr-preview.server";
import { useT } from "../../i18n";

// «Levantar preview» para un PR SIN pedido de la fábrica (dependabot, personas). El de un pedido
// tiene la suya automática en la caja del pedido y aquí no se pinta nada (el servidor lo dice).
// Mientras construye se pregunta cada 5 s; lista → «Ver preview» con la liga completa (lleva llave).
// Sin lugar (todos los lugares del tier son pedidos) → línea ámbar «se levanta sola» y se pregunta
// cada 15 s; soltada por un pedido u otra preview → el botón vuelve con la nota.

const WORKING = new Set(["creating", "fetching", "installing", "building", "starting"]);

export function PrPreviewButton({ channelId, repo, number }: { channelId: number; repo: string; number: number }) {
  const t = useT();
  const [v, setV] = useState<PrPreviewView | null>(null);
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

  const waiting = !!v?.eligible && v.phase === "waiting";
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(refresh, 15_000);
    return () => clearInterval(id);
  }, [waiting, refresh]);

  // gs levanta sola la preview de todo PR no borrador de un repo conectado (servicios del PR, 22-nov): aquí sólo se
  // muestra su estado; sin caja todavía no se pinta nada (antes había botón y salían dos cajas).
  if (!v?.eligible || v.phase === "none" || v.phase === "evicted") return null;

  const phaseLabel: Record<string, string> = {
    creating: t("creando la caja…"),
    fetching: t("bajando el código…"),
    installing: t("instalando…"),
    building: t("construyendo…"),
    starting: t("arrancando…"),
  };

  return (
    <div className="mt-1 flex max-w-xl flex-wrap items-center gap-1.5">
      {v.phase === "ready" && v.url ? (
        <a href={v.url} target="_blank" rel="noreferrer" className="rounded-md border border-brand px-2 py-0.5 text-[11px] font-medium text-brand transition hover:bg-brand/10">
          {t("Ver preview")}
        </a>
      ) : waiting ? (
        <span className="text-[11px] text-amber-600 dark:text-amber-400">
          {v.busy?.length
            ? t("Sin lugar: {n} pedidos en curso ({ids}) · se levanta sola", { n: v.busy.length, ids: v.busy.map((id) => `#${id}`).join(", ") })
            : t("Sin lugar · se levanta sola")}
        </span>
      ) : working ? (
        <span className="text-[11px] text-muted">
          {t("Preview")}: {phaseLabel[v.phase] ?? "…"}
        </span>
      ) : v.phase === "failed" ? (
        <span className="text-[11px] text-muted">{t("Preview")}:</span>
      ) : null}
      {err || (v.phase === "failed" && v.error) ? (
        <span className="min-w-0 flex-1 truncate text-[11px] text-red-500" title={err || v.error || ""}>
          {err || v.error}
        </span>
      ) : null}
    </div>
  );
}
