// Pedidos SUGERIDOS por @plan (```gt-asks```): un botón «Pedir» por pedido que lo manda tal
// cual al room, top-level, para que cada uno abra su propio hilo. Así el primer pedido no
// depende de saber qué pedir (ni de un agente externo que lo redacte).
import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import { askInRoom } from "../../lib/ask-in-room";
import type { AsksCardData } from "../../lib/ebdoc";

const SIZE_TONE: Record<string, string> = {
  chico: "bg-emerald-600/15 text-emerald-700",
  mediano: "bg-amber-500/15 text-amber-700",
  grande: "bg-brand/15 text-brand",
};

// El pedido ya mandado se recuerda en este navegador (room + texto → liga a su hilo): sin esto, al
// volver a entrar la tarjeta ofrecía «Pedir» otra vez y no había cómo llegar al hilo que abrió.
const sentKey = (room: string, ask: string) => `gt-asked:${room}:${ask.slice(0, 120)}`;
function readSent(card: AsksCardData): Record<number, string> {
  const out: Record<number, string> = {};
  try {
    card.items.forEach((it, i) => {
      const url = localStorage.getItem(sentKey(card.roomSlug, it.ask));
      if (url) out[i] = url;
    });
  } catch {
    /* sin localStorage */
  }
  return out;
}

export function AsksCard({ card }: { card: AsksCardData }) {
  const t = useT();
  // índice → liga al hilo que abrió el pedido.
  const [sent, setSent] = useState<Record<number, string>>({});
  useEffect(() => setSent(readSent(card)), [card]);
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState("");

  const ask = async (i: number) => {
    setBusy(i);
    setErr("");
    try {
      // Enviar Y despertar a @plan: con sólo publicar, el pedido se quedaba sin respuesta.
      // El repo va en el pedido: con varios repos, @plan tiene que saber sobre cuál planea.
      const it = card.items[i];
      const { threadUrl } = await askInRoom(card.roomSlug, `@plan ${it.repo ? `(repo ${it.repo}) ` : ""}${it.ask}`);
      setSent((s) => ({ ...s, [i]: threadUrl }));
      try {
        localStorage.setItem(sentKey(card.roomSlug, it.ask), threadUrl);
      } catch {
        /* sin localStorage */
      }
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
              {it.repo && <p className="mt-0.5 font-mono text-[11px] text-muted">{it.repo}</p>}
            </div>
            {sent[i] ? (
              // Ya se pidió: el pedido vive en su propio hilo del room; desde aquí se llega a él.
              <a href={sent[i]} className="shrink-0 rounded-full border border-border px-3 py-1 text-xs font-bold text-ink hover:bg-surface-3">
                {t("Pedido")} ✓ · {t("Ver hilo")} →
              </a>
            ) : (
              <button
                type="button"
                title={it.ask}
                disabled={busy !== null}
                onClick={() => ask(i)}
                className="shrink-0 rounded-full border border-brand px-3 py-1 text-xs font-bold text-brand hover:bg-brand/10 disabled:opacity-50"
              >
                {busy === i ? `${t("Pidiendo")}…` : t("Pedir")}
              </button>
            )}
          </li>
        ))}
      </ul>
      {Object.keys(sent).length > 0 && (
        <p className="px-3 pb-3 text-[11px] text-muted">{t("Cada pedido abre su propio hilo en el room: ahí llega el plan para firmar.")}</p>
      )}
      {err && <p className="px-3 pb-3 text-xs text-danger">{err}</p>}
    </div>
  );
}
