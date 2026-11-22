// El hilo de un pendiente de gs (patrón del agente de Cursor en Slack, aprobado por bliss el 22-nov): lo que dice el
// escritor se pinta como mensajes normales del hilo, intercalados por hora con los de Teams. Es una VISTA: se lee de gs
// en vivo y no se guarda en Teams (una sola fuente). Lo que una persona escribe en el hilo con @ghosty ya es un mensaje
// de Teams; gs no lo regresa (`from: "room"`), así que no sale doble.
import { useEffect, useRef, useState } from "react";
import type { Message } from "../../db.server";
import { useT } from "../../i18n";
import { Markdown } from "../Markdown";
import { devThreadConversationFn, type DevChatMessage } from "../../server/apps/dev-threads";

export type FeedItem = { kind: "real"; m: Message } | { kind: "dev"; d: DevChatMessage; at: number };

/** Intercala los mensajes de Teams con los de gs por hora (puro). Los de gs sin hora van al final, en su orden. */
export function mergeFeed(replies: Message[], dev: DevChatMessage[]): FeedItem[] {
  const items: FeedItem[] = replies.map((m) => ({ kind: "real", m }));
  for (const d of dev) items.push({ kind: "dev", d, at: d.at ? Math.floor(Date.parse(d.at) / 1000) : Number.MAX_SAFE_INTEGER });
  const time = (i: FeedItem) => (i.kind === "real" ? i.m.created_at : i.at);
  return items.map((i, idx) => ({ i, idx })).sort((a, b) => time(a.i) - time(b.i) || a.idx - b.idx).map((x) => x.i);
}

/** La conversación del pendiente para un hilo. `null` si el hilo no es de un pendiente de gs (no se vuelve a preguntar). */
export function useDevFeed(channelId: number, threadId: number) {
  const [state, setState] = useState<{ messages: DevChatMessage[]; writer: { name: string; avatar: string } } | null>(null);
  const lastSeq = useRef(0);
  const isDev = useRef<boolean | null>(null);
  useEffect(() => {
    lastSeq.current = 0;
    isDev.current = null;
    setState(null);
    let alive = true;
    const tick = async () => {
      if (isDev.current === false) return;
      const r = await devThreadConversationFn({ data: { channelId, rootMsgId: threadId, after: lastSeq.current } }).catch(() => undefined);
      if (!alive || r === undefined) return;
      if (r === null) {
        isDev.current = false;
        return;
      }
      isDev.current = true;
      if (r.messages.length) lastSeq.current = Math.max(lastSeq.current, ...r.messages.map((m) => m.seq));
      setState((prev) => {
        const seen = new Set((prev?.messages ?? []).map((m) => m.seq));
        return { writer: r.writer, messages: [...(prev?.messages ?? []), ...r.messages.filter((m) => !seen.has(m.seq))] };
      });
    };
    void tick();
    const id = setInterval(() => void tick(), 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [channelId, threadId]);
  return state;
}

const hhmm = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");

/** Un mensaje del pendiente en el hilo, con la misma forma que los de Teams (avatar, nombre, hora, cuerpo). */
export function DevFeedRow({ d, writer }: { d: DevChatMessage; writer: { name: string; avatar: string } }) {
  const t = useT();
  if (d.role === "platform") {
    return <div className="py-1 pl-11 text-xs text-muted">{d.text}</div>;
  }
  const isWriter = d.role === "writer";
  const name = isWriter ? writer.name : d.by ?? t("Persona");
  return (
    <div className="flex gap-3 px-1 py-2">
      {isWriter && writer.avatar ? (
        <img src={writer.avatar} alt="" className="h-9 w-9 shrink-0 rounded-lg" />
      ) : (
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface-3 text-xs font-bold text-muted">{name.replace(/^@/, "").slice(0, 2).toUpperCase()}</div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-ink">{name}</span>
          {isWriter && <span className="rounded bg-surface-3 px-1 text-[10px] font-bold uppercase tracking-wide text-muted">{t("Agente")}</span>}
          <span className="text-xs text-muted">{hhmm(d.at)}</span>
        </div>
        <div className="text-sm text-ink">
          <Markdown body={d.text} />
        </div>
      </div>
    </div>
  );
}
