import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowUp, Check, ChevronDown, ChevronUp, FileText, Loader2, Mail, Paperclip, Square, X } from "lucide-react";
import { DropOverlay, useAdjuntos, useFileDrop } from "../chat/adjuntos";
import { drawerHistoryFn, listProspAgentsFn, previewSendFn } from "../../server/prospeccion";
import { MailPreview } from "./MailPreview";
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
  messages,
  previewKey,
  onSend,
}: {
  open: boolean;
  onClose: () => void;
  listId: number;
  /** El filtro actual, codificado. Va en cada turno: el agente opera sobre la VISTA. */
  filter: string | undefined;
  /** Lo que se propone cuando la conversación está vacía. Sale de los huecos de los datos. */
  suggestions: string[];
  /** Columnas que pueden ser el cuerpo del correo (las `ai` escritas y las manuales). */
  messages?: { key: string; label: string }[];
  /** La última columna de mensaje que se escribió: es la que se enseña sin preguntar. */
  previewKey?: string | null;
  /** Abre la revisión de envío con esa columna ya elegida. */
  onSend?: (messageKey: string) => void;
}) {
  const t = useT();
  const still = useReducedMotion();
  /**
   * Adjuntos del turno: el análisis de servicio, la propuesta, el PDF con precios. Mismo
   * camino que el chat (`/api/upload` → fileId → el agente recibe ACCESO al archivo, no el
   * archivo). Sin esto el usuario tenía que pegar su documento como texto.
   */
  const adjuntos = useAdjuntos();
  const fileRef = useRef<HTMLInputElement>(null);
  const drop = useFileDrop((files) => adjuntos.addFiles(files));
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

  /*
    El historial vive en el SERVIDOR desde el 2026-08-23.

    ⚠️ Antes sólo estaba en `historyCache`, un Map de módulo, y eso dejaba la peor
    combinación posible: el agente SÍ recuerda —su sesión `prosp:drawer:<lista>:<sub>`
    persiste en el worker— pero al recargar la persona no veía nada y se re-explicaba lo
    que él ya sabía.

    Sólo se pide si el caché está vacío: dentro de la misma pestaña el caché ya es la
    verdad, y volver a pedirlo haría parpadear la conversación al reabrir el panel.
  */
  useEffect(() => {
    if (!open || historyCache.get(listId)?.length) return;
    let vivo = true;
    drawerHistoryFn({ data: { listId } })
      .then((r) => {
        if (!vivo || !r.msgs.length) return;
        const cargados: Msg[] = r.msgs.map((m) =>
          m.role === "user"
            ? ({ role: "user", text: m.text } as Msg)
            : ({
                role: "agent",
                text: m.text,
                // Se guardan sólo los NOMBRES; el resto del estado (girando, ×N) es de un
                // turno vivo y no significa nada en un turno ya cerrado.
                tools: (m.tools ?? []).map((label) => ({ label, status: "done" as const })),
                running: false,
              } as Msg)
        );
        historyCache.set(listId, cargados);
        setMsgs(cargados);
      })
      .catch(() => {});
    return () => { vivo = false; };
  }, [open, listId]);

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
      if (!q || running || adjuntos.subiendo) return;
      const attachments = adjuntos.listos();
      const nombres = attachments.map((a) => a.name).filter(Boolean);
      setText("");
      adjuntos.limpiar();
      setMsgs((m) => [...m, { role: "user", text: nombres.length ? `${q}\n📎 ${nombres.join(", ")}` : q }, { role: "agent", text: "", tools: [], running: true }]);
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
          body: JSON.stringify({ listId, text: q, filter, handle, attachments }),
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
    [listId, filter, running, handle, t, adjuntos]
  );

  const stop = () => { abortRef.current?.abort(); setRunning(false); };

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          ref={panelRef}
          {...drop.handlers}
          role="dialog"
          aria-modal="false"
          aria-label={t("Agente de prospección")}
          initial={still ? false : { x: "100%", opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: "100%", opacity: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          className="fixed bottom-0 right-0 top-0 z-40 flex w-full max-w-sm flex-col border-l border-border bg-surface shadow-2xl"
        >
          <DropOverlay show={drop.dragOver} />
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
                    {/* Con cero herramientas no hay tarjeta: «0 herramientas ✓» ocupa una
                        línea para decir que no pasó nada. */}
                    {m.tools.length ? <ToolGroup tools={m.tools} vivo={!!m.running} /> : null}
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

          {messages && messages.length ? (
            <MailCard
              listId={listId}
              filter={filter}
              messages={messages}
              previewKey={previewKey ?? null}
              onSend={onSend}
            />
          ) : null}

          <footer className="shrink-0 border-t border-border p-3">
            {adjuntos.pendientes.length ? (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {adjuntos.pendientes.map((a) => (
                  <span key={a.localId} className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] ${a.error ? "border-red-400 text-red-500" : "border-border bg-surface-2"}`}>
                    {a.uploading ? <Loader2 size={11} className="animate-spin" /> : <FileText size={11} />}
                    <span className="max-w-[160px] truncate">{a.name}</span>
                    <button onClick={() => adjuntos.quitar(a.localId)} className="text-muted hover:text-ink"><X size={11} /></button>
                  </span>
                ))}
              </div>
            ) : null}
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={(e) => { if (e.target.files?.length) adjuntos.addFiles(e.target.files); e.target.value = ""; }}
            />
            <div className="flex items-center gap-2 rounded-xl border border-border bg-surface-2 px-3 py-2 focus-within:border-brand">
              <button onClick={() => fileRef.current?.click()} title={t("Adjuntar un archivo para que lo lea")} className="shrink-0 text-muted hover:text-ink">
                <Paperclip size={14} />
              </button>
              <textarea
                ref={inputRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(text); }
                }}
                rows={1}
                placeholder={t("filtra las que no tienen teléfono… o suelta un archivo")}
                className="max-h-32 min-w-0 flex-1 resize-none self-center bg-transparent py-1 text-xs leading-5 outline-none placeholder:text-muted"
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

/**
 * «Así se verá el correo», al pie del hilo.
 *
 * Es la respuesta a "¿dónde lo veo mientras lo construye?". La columna es la fuente de
 * verdad y esto es sólo lectura: cambiar el texto se pide al agente, no se edita aquí. Se
 * vuelve a pedir cuando cambia la columna o el filtro — el ejemplo es la primera fila de la
 * VISTA con mensaje y correo, así que otro filtro puede dar otro ejemplo.
 */
function MailCard({
  listId,
  filter,
  messages,
  previewKey,
  onSend,
}: {
  listId: number;
  filter: string | undefined;
  messages: { key: string; label: string }[];
  previewKey: string | null;
  onSend?: (messageKey: string) => void;
}) {
  const t = useT();
  const [key, setKey] = useState<string>(previewKey ?? messages[0]?.key ?? "");
  // Una columna recién escrita gana: es lo que el usuario acaba de pedir.
  useEffect(() => { if (previewKey) setKey(previewKey); }, [previewKey]);
  // Y se abre sola sólo cuando llega una nueva; si el usuario la cerró, se queda cerrada.
  const [open, setOpen] = useState(!!previewKey);
  useEffect(() => { if (previewKey) setOpen(true); }, [previewKey]);
  const [state, setState] = useState<{ html: string; marca: string | null } | { error: string } | null>(null);

  useEffect(() => {
    if (!open || !key) return;
    let alive = true;
    setState(null);
    previewSendFn({ data: { listId, f: filter, messageKey: key, subject: "" } })
      .then((r) => {
        if (!alive) return;
        setState(r.ok ? { html: r.html, marca: r.marca ?? null } : { error: r.error || t("No se pudo previsualizar") });
      })
      .catch(() => { if (alive) setState({ error: t("No se pudo previsualizar") }); });
    return () => { alive = false; };
  }, [open, key, filter, listId, t]);

  const current = messages.find((m) => m.key === key) ?? messages[0];
  if (!current) return null;

  return (
    <div className="shrink-0 border-t border-border" data-keep-agent>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-2 text-xs font-medium hover:bg-surface-2"
      >
        <Mail size={13} className="text-brand" />
        <span className="flex-1 text-left">{t("Así se verá el correo")}</span>
        {open ? <ChevronUp size={13} className="text-muted" /> : <ChevronDown size={13} className="text-muted" />}
      </button>
      {open ? (
        <div className="px-4 pb-3">
          {messages.length > 1 ? (
            <select
              value={current.key}
              onChange={(e) => setKey(e.target.value)}
              className="mb-2 w-full rounded-lg border border-border bg-surface-2 px-2 py-1 text-xs"
            >
              {messages.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          ) : null}
          {state === null ? (
            <p className="text-[11px] text-muted">{t("Armando el ejemplo…")}</p>
          ) : "error" in state ? (
            <p className="text-[11px] text-muted">{state.error}</p>
          ) : (
            <MailPreview html={state.html} marca={state.marca} />
          )}
          {onSend ? (
            <button
              onClick={() => onSend(current.key)}
              className="mt-2 text-xs font-medium text-brand underline underline-offset-2"
            >
              {t("Abrir en Mandar")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
