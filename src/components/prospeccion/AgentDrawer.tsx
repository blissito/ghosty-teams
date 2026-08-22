import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowUp, Check, ChevronDown, Square, X } from "lucide-react";
import { listProspAgentsFn } from "../../server/prospeccion";
import { useT } from "../../i18n";
import { registerModalEsc } from "../../utils/modal-esc";
import { Markdown } from "../Markdown";
import { toolLabel, TOOLS_OCULTAS } from "../../lib/tool-label";
// ⚠️ El checklist de herramientas NO se reimplementa: `ToolGroup` de Teams ya lleva dentro
// tres incidentes pagados — que trabajar gane sobre fallar en el estado del grupo, que un
// fallo de quince no pinte los quince en rojo, y que el anillo no gire para siempre cuando
// el turno murió. Escribí uno al lado y era peor en las tres cosas.
import { ToolGroup } from "../chat/message";
import type { ToolState } from "../../lib/ebdoc";

/**
 * El agente, aquí.
 *
 * Portado del `AgentDrawer` de Ghosty Tasks (`~/ghosty-tasks/src/components/AgentDrawer.tsx`),
 * con su transporte cambiado: allá habla con el tablero, aquí con una lista de prospección.
 *
 * Lo que se conserva de allá porque ya está pagado en horas:
 *  · Entra por la derecha con spring {300, 30}, `top-14`, **sin overlay** — se sigue
 *    trabajando con la rejilla mientras contesta. Un panel modal aquí sería absurdo: la
 *    mitad de lo que hace es cambiar lo que estás mirando.
 *  · Cierre por listener de `mousedown` y NO por una capa. Con capa, el primer clic fuera
 *    se lo traga la capa y abrir otra cosa cuesta dos clics.
 *  · Agrupación de herramientas repetidas con ×N: seis «Filtré la lista» seguidas no dicen
 *    nada.
 *
 * Lo que se AÑADE, porque Tasks no lo tiene: `role="dialog"`, devolver el foco al cerrar, y
 * `useReducedMotion()`.
 */

export type Msg =
  | { role: "user"; text: string }
  | { role: "agent"; text: string; tools: ToolState[]; running?: boolean };

/** Historial por lista, a nivel de módulo: reabrir el drawer no lo pierde. */
const historyCache = new Map<number, Msg[]>();
/** Con qué agente se estaba hablando en cada lista. */
const agentCache = new Map<number, string>();

export function AgentDrawer({
  open,
  onClose,
  listId,
  filter,
  suggestions,
}: {
  open: boolean;
  onClose: () => void;
  listId: number;
  /** El filtro actual, codificado. Va en cada turno: el agente opera sobre la VISTA. */
  filter: string | undefined;
  /** Lo que se propone cuando la conversación está vacía. Sale de los huecos de los datos. */
  suggestions: string[];
}) {
  const t = useT();
  const still = useReducedMotion();
  const [msgs, setMsgs] = useState<Msg[]>(() => historyCache.get(listId) ?? []);
  const [text, setText] = useState("");
  const [running, setRunning] = useState(false);
  /**
   * Con quién se habla.
   *
   * Un workspace tiene varios agentes y cada uno es un motor y un modelo distintos —
   * elegirlo aquí no es una preferencia, es decidir quién hace el trabajo y a qué costo.
   * La elección se recuerda por lista: quien usa uno barato para filtrar y otro bueno para
   * redactar no quiere volver a elegir en cada mensaje.
   */
  const [agents, setAgents] = useState<{ handle: string; name: string }[]>([]);
  const [handle, setHandle] = useState<string | null>(() => agentCache.get(listId) ?? null);
  const [picking, setPicking] = useState(false);
  const pickRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => { setMsgs(historyCache.get(listId) ?? []); setHandle(agentCache.get(listId) ?? null); }, [listId]);

  useEffect(() => {
    if (!open || agents.length) return;
    listProspAgentsFn()
      .then((a) => { setAgents(a); if (!handle && a[0]) setHandle(a[0].handle); })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => { if (handle) agentCache.set(listId, handle); }, [listId, handle]);

  useEffect(() => {
    if (!picking) return;
    const close = (e: MouseEvent) => { if (!pickRef.current?.contains(e.target as Node)) setPicking(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [picking]);
  useEffect(() => { historyCache.set(listId, msgs); }, [listId, msgs]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs]);

  // Foco al abrir, y DEVOLVERLO al cerrar. Sin lo segundo, cerrar el panel deja al teclado
  // en la nada y hay que volver a alcanzar la pantalla con el ratón.
  useEffect(() => {
    if (!open) return;
    returnFocus.current = document.activeElement as HTMLElement | null;
    const id = setTimeout(() => inputRef.current?.focus(), 60);
    return () => { clearTimeout(id); returnFocus.current?.focus?.(); };
  }, [open]);

  useEffect(() => (open ? registerModalEsc(onClose) : undefined), [open, onClose]);

  // Cierre por LISTENER, no por capa. Con una capa, el primer clic fuera se lo traga ella y
  // seleccionar una celda de la rejilla costaría dos clics.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (panelRef.current?.contains(el)) return;
      if (el.closest("[data-keep-agent]")) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, onClose]);

  const send = useCallback(
    async (raw: string) => {
      const q = raw.trim();
      if (!q || running) return;
      setText("");
      setMsgs((m) => [...m, { role: "user", text: q }, { role: "agent", text: "", tools: [], running: true }]);
      setRunning(true);

      const ctrl = new AbortController();
      abortRef.current = ctrl;

      const patch = (fn: (last: Extract<Msg, { role: "agent" }>) => void) =>
        setMsgs((m) => {
          const next = [...m];
          const last = next[next.length - 1];
          if (last?.role === "agent") { const copy = { ...last }; fn(copy); next[next.length - 1] = copy; }
          return next;
        });

      try {
        const res = await fetch("/api/prospeccion/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ listId, text: q, filter, handle }),
          signal: ctrl.signal,
        });
        if (!res.body) throw new Error("sin respuesta");

        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          // SSE: los eventos van separados por línea en blanco. Lo que quede a medias se
          // guarda para el siguiente chunk — un evento partido por el borde de un paquete
          // es lo normal, no la excepción.
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const p of parts) {
            const line = p.trim();
            if (!line.startsWith("data:")) continue;
            let ev: { t: string; v?: unknown };
            try { ev = JSON.parse(line.slice(5)); } catch { continue; }
            if (ev.t === "delta") patch((l) => { l.text += String(ev.v ?? ""); });
            else if (ev.t === "tool") {
              // ⚠️ El evento viene en PARES `start`/`end` y el `end` no trae nombre. Pintar
              // los dos producía una línea «…» entre cada herramienta — que es justo el
              // amontonamiento que se veía. Sólo el `start` es una acción nueva.
              const e = ev.v as { name?: string; phase?: string; detail?: string };
              if (e.phase === "end" || !e.name) continue;
              // Las ocultas son contabilidad interna del agente (TodoWrite, ToolSearch):
              // enseñarlas llena la lista de ruido y esconde lo que de verdad hizo.
              if (TOOLS_OCULTAS.has(e.name)) continue;
              const lbl = toolLabel(e.name);
              patch((l) => {
                // La anterior pasa a `done` y la nueva entra `running`: es el checklist
                // incremental del chat, no una lista que sólo crece.
                const previas = l.tools.map((x) => (x.status === "running" ? { ...x, status: "done" as const } : x));
                const ultima = previas[previas.length - 1];
                const etiqueta = lbl?.ing ?? e.name!;
                // Repetida seguida: sube el contador en vez de añadir otra línea.
                if (ultima && ultima.label === etiqueta && ultima.detail === e.detail) {
                  ultima.n = (ultima.n ?? 1) + 1;
                  ultima.status = "running";
                  l.tools = [...previas];
                } else {
                  l.tools = [...previas, { label: etiqueta, status: "running", detail: e.detail }];
                }
              });
            } else if (ev.t === "error") patch((l) => { l.text = String(ev.v ?? "Algo falló."); });
          }
        }
      } catch (e) {
        if (!ctrl.signal.aborted) {
          patch((l) => { l.text = l.text || t("No se pudo hablar con el agente."); });
        }
      } finally {
        patch((l) => {
          l.running = false;
          // Lo que quedó corriendo cuando el turno cerró ya terminó: si no, el checklist
          // se queda con un anillo eterno.
          l.tools = l.tools.map((x) => (x.status === "running" ? { ...x, status: "done" as const } : x));
        });
        setRunning(false);
        abortRef.current = null;
      }
    },
    [listId, filter, running, handle, t]
  );

  const stop = () => { abortRef.current?.abort(); setRunning(false); };

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          ref={panelRef}
          role="dialog"
          aria-modal="false"
          aria-label={t("Agente de prospección")}
          initial={still ? false : { x: "100%", opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: "100%", opacity: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          className="fixed bottom-0 right-0 top-0 z-40 flex w-full max-w-sm flex-col border-l border-border bg-surface shadow-2xl"
        >
          <header className="shrink-0 flex items-center justify-between border-b border-border px-4 py-3">
            <div ref={pickRef} className="relative min-w-0">
              <button
                onClick={() => setPicking((v) => !v)}
                disabled={agents.length < 2}
                className="flex items-center gap-1.5 text-sm font-semibold min-w-0 disabled:cursor-default"
              >
                <span className="truncate">
                  {agents.find((a) => a.handle === handle)?.name ?? t("Pídeselo al agente")}
                </span>
                {agents.length > 1 ? (
                  <ChevronDown size={13} className={`shrink-0 text-muted transition-transform ${picking ? "rotate-180" : ""}`} />
                ) : null}
              </button>
              <div className="text-[11px] text-muted">{t("Trabaja sobre lo que estás viendo")}</div>

              <AnimatePresence>
                {picking ? (
                  <motion.div
                    initial={still ? false : { opacity: 0, y: -4, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -4, scale: 0.97 }}
                    transition={{ duration: 0.12 }}
                    className="absolute left-0 top-full mt-1 z-20 gt-card rounded-xl py-1 min-w-[200px] shadow-2xl"
                  >
                    {agents.map((a) => (
                      <button
                        key={a.handle}
                        onClick={() => { setHandle(a.handle); setPicking(false); }}
                        className="w-full text-left px-3 py-2 text-xs hover:bg-surface-3 flex items-center gap-2"
                      >
                        {a.handle === handle ? <Check size={12} className="text-brand shrink-0" /> : <span className="w-3" />}
                        <span className="truncate">{a.name}</span>
                        <span className="ml-auto text-[10px] text-muted shrink-0">@{a.handle}</span>
                      </button>
                    ))}
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-lg text-muted hover:bg-surface-3">
              <X size={16} />
            </button>
          </header>

          <div className="flex-1 overflow-y-auto px-4 py-3 thin-scroll">
            {msgs.length === 0 ? (
              <div className="flex flex-col gap-2 pt-2">
                <p className="text-xs text-muted mb-1">{t("Por ejemplo:")}</p>
                {suggestions.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    className="text-left text-xs rounded-lg border border-border bg-surface-2 px-3 py-2 hover:bg-surface-3"
                  >
                    {s}
                  </button>
                ))}
              </div>
            ) : (
              msgs.map((m, i) =>
                m.role === "user" ? (
                  <div key={i} className="mb-3 flex justify-end">
                    <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-brand px-3 py-2 text-xs text-brand-fg">
                      {m.text}
                    </div>
                  </div>
                ) : (
                  <div key={i} className="mb-3">
                    {/* `vivo` = si este turno sigue corriendo. Sin eso, un turno terminado
                        deja el anillo girando para siempre. */}
                    <ToolGroup tools={m.tools} vivo={!!m.running} />
                    {m.text ? (
                      // El renderer del chat: Streamdown cierra el markdown incompleto EN
                      // VIVO, así que una tabla o un bloque a medio llegar no parpadean.
                      <div className="text-xs leading-relaxed">
                        <Markdown body={m.text} />
                      </div>
                    ) : m.running && !m.tools.length ? (
                      <div className="flex items-center gap-2 text-xs text-muted">
                        <span className="h-3 w-3 animate-spin rounded-full border-2 border-muted/40 border-t-brand" />
                        {t("pensando…")}
                      </div>
                    ) : null}
                  </div>
                )
              )
            )}
            <div ref={bottomRef} />
          </div>

          <footer className="shrink-0 border-t border-border p-3">
            <div className="flex items-end gap-2 rounded-xl border border-border bg-surface-2 px-3 py-2 focus-within:border-brand">
              <textarea
                ref={inputRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(text); }
                }}
                rows={1}
                placeholder={t("filtra las que no tienen teléfono…")}
                className="max-h-32 min-w-0 flex-1 resize-none bg-transparent text-xs outline-none placeholder:text-muted"
              />
              {running ? (
                <button onClick={stop} title={t("Detener")} className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface-3 hover:bg-border">
                  <Square size={12} />
                </button>
              ) : (
                <button
                  onClick={() => send(text)}
                  disabled={!text.trim()}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand text-brand-fg hover:brightness-110 disabled:opacity-40"
                >
                  <ArrowUp size={14} />
                </button>
              )}
            </div>
          </footer>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
