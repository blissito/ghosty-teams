import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, ChevronLeft, ChevronRight, Sparkles, TestTube2, X } from "lucide-react";
import { useT } from "../../i18n";
import { MailPreview } from "./MailPreview";
import { getCampaignMessageFn, getCampaignSignatureFn, previewSendFn, saveCampaignMessageFn, setCampaignSignatureFn } from "../../server/prospeccion";
import { listVars, missingVars, type VarColumn, type VarRow } from "../../lib/prospeccion-vars";

/**
 * El mensaje de la campaña: lo redacta el agente, lo ajusta la persona.
 *
 * Es el editor de secuencia de lemlist/Instantly en una sola pantalla: asunto y cuerpo a la
 * izquierda con variables de un clic, y a la derecha el correo TAL COMO LLEGA a un prospecto
 * real de la vista (‹ 1 de 18 ›), con el botón de WhatsApp. Antes el texto sólo lo podía
 * escribir el agente y cambiar una palabra costaba otro turno.
 *
 * Se guarda solo (por campaña) y la vista previa se pide DESPUÉS de guardar: es el mismo
 * camino que el envío (`previewSendFn` lee lo guardado), así que lo que se ve es lo que sale.
 */
export function MessageSheet({
  open,
  onClose,
  listId,
  filter,
  columns,
  rows,
  reloadKey,
  onAskAgent,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  listId: number;
  filter: string | undefined;
  columns: VarColumn[];
  /** Las filas a la vista: para avisar cuántas se quedan sin el dato de una variable. */
  rows: VarRow[];
  /** Cambia cuando el agente termina un turno: puede haber reescrito el mensaje. */
  reloadKey?: unknown;
  onAskAgent: (prompt: string) => void;
  onSaved?: () => void;
}) {
  const t = useT();
  const still = useReducedMotion();
  const [text, setText] = useState("");
  const [subject, setSubject] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [estado, setEstado] = useState<"idle" | "saving" | "saved">("idle");
  const [preview, setPreview] = useState<string | null>(null);
  const [marca, setMarca] = useState<string | null>(null);
  const [nth, setNth] = useState(0);
  const [nav, setNav] = useState<{ total: number; rowName: string | null } | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [probando, setProbando] = useState(false);
  const [pedido, setPedido] = useState("");
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const lastFocus = useRef<"subject" | "body">("body");
  const subjectRef = useRef<HTMLInputElement>(null);
  const dirty = useRef(false);
  // La firma de ESTA campaña. Antes heredaba la del espacio y la de agencias firmaba «Normi».
  type Firma = { business: string; title: string; tagline: string; website: string };
  const [firma, setFirma] = useState<Firma | null>(null);
  const [firmaError, setFirmaError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    getCampaignSignatureFn({ data: { listId } }).then((r) => r && setFirma(r)).catch(() => {});
  }, [open, listId, reloadKey]);
  const guardarFirma = async (campo: keyof Firma, valor: string) => {
    if (!firma || firma[campo] === valor.trim()) return;
    const r = await setCampaignSignatureFn({ data: { listId, [campo]: valor.trim() } }).catch(() => null);
    if (r && "ok" in r && r.ok === false) { setFirmaError(("error" in r && r.error) || null); return; }
    setFirmaError(null);
    setFirma({ ...firma, [campo]: valor.trim() });
    onSaved?.();
    void pedirPreview(nth);
  };

  // Cargar (al abrir y cuando el agente terminó un turno), sin pisar lo que se está escribiendo.
  useEffect(() => {
    if (!open) { setLoaded(false); dirty.current = false; return; }
    if (dirty.current) return;
    getCampaignMessageFn({ data: { listId } })
      .then((r) => { if (r) { setText(r.text); setSubject(r.subject); setLoaded(true); } })
      .catch(() => setLoaded(true));
  }, [open, listId, reloadKey]);

  const pedirPreview = useCallback(
    async (n: number, test = false) => {
      const r = await previewSendFn({ data: { listId, f: filter, messageKey: "__base__", subject, test, nth: n } }).catch(() => null);
      if (!r) return;
      if (!r.ok) { setPreview(null); setNav(null); return; }
      setPreview(r.html);
      setMarca(("marca" in r ? r.marca : null) ?? null);
      if ("total" in r && r.total) setNav({ total: r.total, rowName: ("rowName" in r && r.rowName) || null });
      if (test) setAviso(r.sent ? `${t("Prueba enviada a")} ${r.to}` : t("No se pudo mandar la prueba"));
    },
    [listId, filter, subject, t]
  );

  // Guardar solo, 700 ms después de la última tecla, y luego refrescar la vista previa.
  useEffect(() => {
    if (!open || !loaded) return;
    if (!dirty.current) { void pedirPreview(nth); return; }
    setEstado("saving");
    const h = setTimeout(async () => {
      await saveCampaignMessageFn({ data: { listId, text, subject } }).catch(() => {});
      dirty.current = false;
      setEstado("saved");
      onSaved?.();
      void pedirPreview(nth);
    }, 700);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, subject, open, loaded]);

  useEffect(() => { if (open && loaded) void pedirPreview(nth); }, [nth]); // eslint-disable-line react-hooks/exhaustive-deps

  const vars = useMemo(() => listVars(columns), [columns]);
  const faltan = useMemo(
    () => missingVars(`${subject}\n${text}`, rows, columns).filter((m) => m.missing > 0 && !m.hasFallback),
    [subject, text, rows, columns]
  );

  /** Inserta la variable donde está el cursor (en el asunto o en el cuerpo, el último que se tocó). */
  const insertar = (name: string) => {
    const tag = `{${name}}`;
    const el = lastFocus.current === "subject" ? subjectRef.current : bodyRef.current;
    const cur = lastFocus.current === "subject" ? subject : text;
    const start = el?.selectionStart ?? cur.length;
    const end = el?.selectionEnd ?? cur.length;
    const next = cur.slice(0, start) + tag + cur.slice(end);
    dirty.current = true;
    if (lastFocus.current === "subject") setSubject(next);
    else setText(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + tag.length, start + tag.length);
    });
  };

  const pedirAlAgente = () => {
    const q = pedido.trim() || t("Escribe el mensaje base de esta campaña");
    setPedido("");
    onAskAgent(`${q} (guárdalo como mensaje base de esta campaña; usa {negocio} donde vaya el nombre)`);
  };

  const probar = async () => {
    setProbando(true);
    setAviso(null);
    await pedirPreview(nth, true);
    setProbando(false);
    onSaved?.();
  };

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink/25 backdrop-blur-sm"
          initial={still ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            className="gt-card rounded-2xl w-full max-w-5xl h-[88vh] flex flex-col overflow-hidden shadow-2xl"
            initial={still ? false : { opacity: 0, y: 12, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.985 }}
            transition={{ type: "spring", stiffness: 460, damping: 34 }}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="shrink-0 flex items-center justify-between gap-3 px-5 py-3 border-b border-border">
              <div className="min-w-0">
                <h2 className="font-bold text-[15px]">{t("Mensaje de la campaña")}</h2>
                <p className="text-xs text-muted mt-0.5">
                  {estado === "saving" ? t("Guardando…") : estado === "saved" ? (
                    <span className="inline-flex items-center gap-1"><Check size={11} /> {t("Guardado")}</span>
                  ) : t("Se guarda solo mientras escribes")}
                </p>
              </div>
              <button onClick={onClose} className="p-1.5 rounded-lg text-muted hover:bg-surface-3" aria-label={t("Cerrar")}>
                <X size={16} />
              </button>
            </header>

            <div className="flex-1 min-h-0 grid md:grid-cols-2 overflow-y-auto md:overflow-hidden">
              {/* ── Izquierda: escribir ── */}
              <div className="flex flex-col gap-3 p-5 md:overflow-y-auto md:border-r border-border">
                {/* Lo más fácil primero: pedírselo al agente. */}
                <div className="flex items-center gap-2 rounded-xl border border-brand/40 bg-brand/5 px-3 py-2">
                  <Sparkles size={14} className="text-brand shrink-0" />
                  <input
                    value={pedido}
                    onChange={(e) => setPedido(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") pedirAlAgente(); }}
                    placeholder={text.trim() ? t("Pídele un cambio: «más corto», «tutea»…") : t("Pídeselo al agente: qué ofreces y a quién")}
                    className="flex-1 min-w-0 bg-transparent text-sm outline-none placeholder:text-muted"
                  />
                  <button onClick={pedirAlAgente} className="text-xs font-semibold text-brand hover:underline shrink-0">
                    {text.trim() ? t("Pedir cambio") : t("Que lo escriba")}
                  </button>
                </div>

                <label className="text-[10px] uppercase tracking-wide text-muted">{t("Asunto")}</label>
                <input
                  ref={subjectRef}
                  value={subject}
                  onFocus={() => (lastFocus.current = "subject")}
                  onChange={(e) => { dirty.current = true; setSubject(e.target.value); }}
                  placeholder={t("¿Tus clientes ya te piden un agente de WhatsApp?")}
                  className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
                />

                <label className="text-[10px] uppercase tracking-wide text-muted">{t("Mensaje")}</label>
                <textarea
                  ref={bodyRef}
                  value={text}
                  onFocus={() => (lastFocus.current = "body")}
                  onChange={(e) => { dirty.current = true; setText(e.target.value); }}
                  placeholder={loaded ? t("Hola, equipo de {negocio}: …") : t("Cargando…")}
                  className="flex-1 min-h-[16rem] rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm leading-relaxed outline-none focus:border-brand resize-none"
                />

                {/* La firma: quién escribe y de qué empresa. Es de la campaña, no del espacio. */}
                {firma ? (
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-muted mb-1.5">{t("Firma de esta campaña")}</p>
                    <div className="grid grid-cols-2 gap-2">
                      {([
                        ["business", t("Empresa"), "Ghosty Studio"],
                        ["title", t("Cargo"), "Founder"],
                        ["website", t("Sitio (con https://)"), "https://ghosty.studio"],
                        ["tagline", t("Qué hacen, en una línea"), t("Agentes de IA para negocios")],
                      ] as const).map(([campo, label, ph]) => (
                        <input
                          key={`${campo}-${firma[campo]}`}
                          defaultValue={firma[campo]}
                          placeholder={`${label}: ${ph}`}
                          aria-label={label}
                          onBlur={(e) => guardarFirma(campo, e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                          className="rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-xs outline-none focus:border-brand"
                        />
                      ))}
                    </div>
                    {firmaError ? <p className="text-[11px] text-red-500 mt-1">{firmaError}</p> : null}
                  </div>
                ) : null}

                {/* Variables de un clic: se llenan con cada prospecto al mandar. */}
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-muted mb-1.5">{t("Insertar dato del prospecto")}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {vars.map((v) => (
                      <button
                        key={v.name}
                        onClick={() => insertar(v.name)}
                        title={v.label}
                        className="rounded-full border border-border bg-surface-2 px-2.5 py-0.5 text-[11px] font-mono hover:border-brand hover:text-brand"
                      >
                        {`{${v.name}}`}
                      </button>
                    ))}
                  </div>
                  {faltan.length ? (
                    <p className="text-[11px] text-amber-500 mt-2">
                      {faltan.map((m) => `${m.missing} ${t("de")} ${rows.length} ${t("sin")} {${m.name}}`).join(" · ")}
                      {" — "}{t("ponle un respaldo:")} <span className="font-mono">{`{${faltan[0].name}|…}`}</span>
                    </p>
                  ) : null}
                </div>
              </div>

              {/* ── Derecha: como llega ── */}
              <div className="flex flex-col p-5 gap-2 bg-surface-2/40 md:overflow-y-auto">
                <div className="flex items-center justify-between gap-2 text-xs text-muted">
                  <span className="truncate">
                    {t("Así le llega a")} <span className="text-ink font-medium">{nav?.rowName ?? "—"}</span>
                  </span>
                  {nav && nav.total > 1 ? (
                    <span className="inline-flex items-center gap-1 shrink-0">
                      <button onClick={() => setNth((n) => Math.max(0, n - 1))} disabled={nth === 0} className="p-1 rounded hover:bg-surface-3 disabled:opacity-30" aria-label={t("Anterior")}>
                        <ChevronLeft size={14} />
                      </button>
                      <span className="tabular-nums">{nth + 1} {t("de")} {nav.total}</span>
                      <button onClick={() => setNth((n) => Math.min(nav.total - 1, n + 1))} disabled={nth >= nav.total - 1} className="p-1 rounded hover:bg-surface-3 disabled:opacity-30" aria-label={t("Siguiente")}>
                        <ChevronRight size={14} />
                      </button>
                    </span>
                  ) : null}
                </div>
                {preview ? (
                  <MailPreview html={preview} marca={marca} mode="inline" fill />
                ) : (
                  <div className="flex-1 grid place-items-center rounded-xl border border-dashed border-border text-xs text-muted p-6 text-center">
                    {text.trim() ? t("Preparando la vista previa…") : t("Escribe o pídele al agente el mensaje y aquí lo ves como llega.")}
                  </div>
                )}
              </div>
            </div>

            <footer className="shrink-0 flex items-center justify-between gap-3 px-5 py-3 border-t border-border">
              <span className="text-xs text-muted truncate">{aviso}</span>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={probar}
                  disabled={!text.trim() || !subject.trim() || probando}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold hover:bg-surface-3 disabled:opacity-40"
                >
                  <TestTube2 size={13} /> {probando ? t("Mandando…") : t("Mandarme una prueba")}
                </button>
                <button onClick={onClose} className="rounded-lg bg-brand text-brand-fg px-4 py-1.5 text-xs font-semibold hover:brightness-110">
                  {t("Listo")}
                </button>
              </div>
            </footer>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
