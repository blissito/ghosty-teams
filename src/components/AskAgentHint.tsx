// «?» que no explica: PREGUNTA. Manda la duda al room con el agente ya mencionado y abre el
// hilo, donde el agente contesta con el contexto real del espacio (su repo, sus horarios).
// Mejor que un tooltip largo que nadie lee y que envejece con el producto.
import { useState } from "react";
import { HelpCircle, Loader2 } from "lucide-react";
import { useT } from "../i18n";
import { askInRoom } from "../lib/ask-in-room";

export function AskAgentHint({ roomSlug, handle, question, label }: { roomSlug: string | null; handle: string; question: string; label?: string }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  if (!roomSlug) return null;
  const ask = async () => {
    setBusy(true);
    try {
      const { threadUrl } = await askInRoom(roomSlug, `@${handle} ${question}`);
      window.location.assign(threadUrl);
    } catch {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={ask}
      disabled={busy}
      title={`${t("Pregúntale a")} @${handle}: ${question}`}
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted hover:bg-surface-3 hover:text-ink disabled:opacity-50"
    >
      {busy ? <Loader2 size={12} className="animate-spin" /> : <HelpCircle size={12} />}
      {label ?? `${t("Pregúntale a")} @${handle}`}
    </button>
  );
}
