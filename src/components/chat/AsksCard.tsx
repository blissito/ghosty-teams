// Pedidos SUGERIDOS por @plan (```gt-asks```): un botón «Pedir» por pedido que lo manda tal
// cual al room, top-level, para que cada uno abra su propio hilo. Así el primer pedido no
// depende de saber qué pedir (ni de un agente externo que lo redacte).
import { useState } from "react";
import { useT } from "../../i18n";
import { postMessage } from "../../server/chat";
import type { AsksCardData } from "../../lib/ebdoc";

const SIZE_TONE: Record<string, string> = {
  chico: "bg-emerald-600/15 text-emerald-700",
  mediano: "bg-amber-500/15 text-amber-700",
  grande: "bg-brand/15 text-brand",
};

export function AsksCard({ card }: { card: AsksCardData }) {
  const t = useT();
  const [sent, setSent] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState("");

  const ask = async (i: number) => {
    setBusy(i);
    setErr("");
    try {
      await postMessage({ data: { slug: card.roomSlug, parentId: null, body: `@plan ${card.items[i].ask}` } });
      setSent((s) => ({ ...s, [i]: true }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-1.5 max-w-xl overflow-hidden rounded-lg gt-card">
      <div className="border-b border-border px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-ink">
        🏭 {t("Pedidos sugeridos")}
      </div>
      <ul className="divide-y divide-border">
        {card.items.map((it, i) => (
          <li key={i} className="flex items-start gap-3 p-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${SIZE_TONE[it.size] ?? SIZE_TONE.mediano}`}>
                  {t(it.size)}
                </span>
                <span className="truncate text-sm font-semibold text-ink">{it.title}</span>
              </div>
              <p className="mt-1 text-xs text-muted">{it.why}</p>
            </div>
            <button
              type="button"
              title={it.ask}
              disabled={busy !== null || sent[i]}
              onClick={() => ask(i)}
              className="shrink-0 rounded-full border border-brand px-3 py-1 text-xs font-bold text-brand hover:bg-brand/10 disabled:opacity-50"
            >
              {sent[i] ? `${t("Pedido")} ✓` : t("Pedir")}
            </button>
          </li>
        ))}
      </ul>
      {err && <p className="px-3 pb-3 text-xs text-danger">{err}</p>}
    </div>
  );
}
