import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { AlertTriangle, Ban, Eye, MailX, Send, Users, X } from "lucide-react";
import { useT } from "../../i18n";
import { MailPreview } from "./MailPreview";
import { planSendFn } from "../../server/prospeccion";

type Plan = Extract<Awaited<ReturnType<typeof planSendFn>>, { ok: true }>;

/**
 * Confirmar antes de mandar.
 *
 * Es un invariante del spec —«el agente propone, la persona confirma todo lo que sale hacia
 * fuera»— y no un adorno: mandar es la única acción de todo el módulo que no se puede
 * deshacer. Un archivo se recupera 30 días; un correo enviado, nunca.
 *
 * Lo que se enseña es la DIFERENCIA entre lo que se ve y lo que va a salir. «Mandar a 312»
 * es mentira si 40 están dadas de baja y 60 tienen el correo muerto: el número real es otro,
 * y verlo antes es lo que evita el «¿por qué sólo salieron 212?» de después.
 */
export function SendReview({
  open,
  onClose,
  listId,
  filter,
  initialSubject,
  initialMessageKey,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  listId: number;
  filter: string | undefined;
  /** El asunto que propuso el agente, si vino de ahí. Editable: propone, no decide. */
  initialSubject?: string;
  /** La columna de mensaje con la que abrir, si viene del panel del agente. */
  initialMessageKey?: string | null;
  onSent: (resumen: string) => void;
}) {
  const t = useT();
  const still = useReducedMotion();
  const [data, setData] = useState<Plan | null>(null);
  const [subject, setSubject] = useState("");
  const [messageKey, setMessageKey] = useState(initialMessageKey ?? "");
  const [sending, setSending] = useState(false);
  /**
   * La previsualización del correo YA RENDERIZADO, y la prueba a uno mismo.
   *
   * Es lo que hacen lemlist y Smartlead antes de lanzar, y por una razón concreta: un HTML
   * se ve distinto en Gmail que en una previsualización, y el botón de WhatsApp o abre o no
   * abre — eso sólo se sabe apretándolo en un cliente de correo real.
   */
  const [preview, setPreview] = useState<string | null>(null);
  const [from, setFrom] = useState<string | null>(null);
  const [armado, setArmado] = useState(false);
  useEffect(() => { setArmado(false); }, [open, messageKey, subject]);
  /** Qué fila se está viendo, de las que tienen mensaje y correo («Quadra · 1 de 17»). */
  const [nth, setNth] = useState(0);
  const [nav, setNav] = useState<{ total: number; rowName: string | null }>({ total: 1, rowName: null });
  useEffect(() => { setNth(0); }, [messageKey]);
  useEffect(() => { if (open) void verPreview(false); // eslint-disable-line react-hooks/exhaustive-deps
  }, [nth]);
  const [probando, setProbando] = useState(false);
  const [pruebaOk, setPruebaOk] = useState<string | null>(null);
  const [sinBoton, setSinBoton] = useState(false);
  const [marca, setMarca] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) { setData(null); setError(null); return; }
    if (initialSubject) setSubject(initialSubject);
    planSendFn({ data: { listId, f: filter } })
      .then((r) => {
        if (!r.ok) return;
        setData(r);
        const pedida = initialMessageKey && r.mensajes.some((m) => m.key === initialMessageKey) ? initialMessageKey : null;
        if (pedida) setMessageKey(pedida);
        else if (r.mensajes[0]) setMessageKey(r.mensajes[0].key);
        if (!initialSubject && r.ultimoAsunto) setSubject((s) => s || r.ultimoAsunto);
      })
      .catch(() => setError(t("No se pudo calcular el envío")));
  }, [open, listId, filter, initialSubject, initialMessageKey, t]);

  // La vista previa se pide sola al elegir el mensaje: «Ver el correo» era un clic que
  // todo el mundo tenía que dar, y sin darlo se mandaba a ciegas.
  useEffect(() => {
    if (!open || !messageKey) return;
    void verPreview(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, messageKey]);

  const verPreview = async (test: boolean) => {
    // ⚠️ El asunto NO hace falta para ver el cuerpo: se previsualiza con «(sin asunto)».
    // Exigirlo escondía los botones justo cuando el aviso de arriba ya decía «míralo con
    // Ver el correo» — mandaba a un botón que no estaba en pantalla.
    if (!messageKey) return;
    setProbando(test);
    setError(null);
    const { previewSendFn } = await import("../../server/prospeccion");
    const r = await previewSendFn({ data: { listId, f: filter, messageKey, subject: subject.trim(), test, nth } })
      .catch(() => ({ ok: false as const, error: t("No se pudo previsualizar"), html: "", to: "", sent: false }));
    setProbando(false);
    if (!r.ok) { setError(("error" in r && r.error) || t("No se pudo previsualizar")); return; }
    setPreview(r.html);
    if ("total" in r && r.total) setNav({ total: r.total, rowName: ("rowName" in r && r.rowName) || null });
    setFrom("from" in r && r.from ? r.from : null);
    setSinBoton(("sinBoton" in r && r.sinBoton) === true);
    setMarca(("marca" in r ? r.marca : null) ?? null);
    if (test && r.sent) setPruebaOk(r.to);
  };

  const enviar = async () => {
    if (sending || !messageKey || !subject.trim()) return;
    setSending(true);
    setError(null);
    const { sendFn } = await import("../../server/prospeccion");
    const r = await sendFn({ data: { listId, f: filter, messageKey, subject: subject.trim() } })
      .catch(() => ({ ok: false as const, error: t("El envío falló") }));
    setSending(false);
    if (!r.ok) { setError(("error" in r && r.error) || t("El envío falló")); return; }
    const s = r as { sent: number; skippedOptOut: number; failed: number };
    onSent(
      `✓ ${s.sent} ${s.sent === 1 ? "correo enviado" : "correos enviados"}` +
        (s.skippedOptOut ? ` · ${s.skippedOptOut} en baja, no salieron` : "") +
        (s.failed ? ` · ${s.failed} fallaron` : "")
    );
    onClose();
  };

  const p = data?.plan;
  const saltados = p ? p.optOut + p.sinCorreo + p.correoMuerto + p.yaTocados + p.enDescanso : 0;
  const puede = !!p && p.irian > 0 && !!messageKey && !!subject.trim();

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
            className="gt-card rounded-2xl w-full max-w-lg max-h-[88vh] flex flex-col overflow-hidden shadow-2xl"
            initial={still ? false : { opacity: 0, y: 12, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.985 }}
            transition={{ type: "spring", stiffness: 460, damping: 34 }}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="shrink-0 flex items-start justify-between px-5 py-4 border-b border-border">
              <div>
                <h2 className="font-bold text-[15px]">{t("Antes de mandar")}</h2>
                <p className="text-xs text-muted mt-0.5">{t("Un correo enviado no se puede deshacer.")}</p>
              </div>
              <button onClick={onClose} className="p-1.5 rounded-lg text-muted hover:bg-surface-3">
                <X size={16} />
              </button>
            </header>

            <div className="flex-1 overflow-y-auto px-5 py-4">
              {!p ? (
                <div className="animate-pulse text-sm text-muted py-6 text-center">{t("Calculando…")}</div>
              ) : (
                <>
                  {/* El número REAL, grande. Es la cifra con la que se decide. */}
                  <div className="text-center py-2">
                    <div className="text-4xl font-bold tabular-nums text-brand">
                      {p.irian.toLocaleString("es-MX")}
                    </div>
                    <div className="text-xs text-muted mt-1">
                      {t("de")} {p.total.toLocaleString("es-MX")} {t("en la vista")}
                    </div>
                  </div>

                  {/* Y por qué los demás no van. Cada línea es una decisión que ya se tomó. */}
                  {saltados ? (
                    <ul className="flex flex-col gap-1.5 mt-4 text-xs">
                      {p.optOut ? (
                        <li className="flex items-center gap-2">
                          <Ban size={13} className="text-red-500 shrink-0" />
                          <span className="tabular-nums font-medium">{p.optOut}</span>
                          <span className="text-muted">{t("dados de baja — no se les escribe nunca")}</span>
                        </li>
                      ) : null}
                      {p.correoMuerto ? (
                        <li className="flex items-center gap-2">
                          <MailX size={13} className="text-amber-500 shrink-0" />
                          <span className="tabular-nums font-medium">{p.correoMuerto}</span>
                          <span className="text-muted">{t("con el correo muerto — rebotarían")}</span>
                        </li>
                      ) : null}
                      {p.sinCorreo ? (
                        <li className="flex items-center gap-2">
                          <MailX size={13} className="text-muted shrink-0" />
                          <span className="tabular-nums font-medium">{p.sinCorreo}</span>
                          <span className="text-muted">{t("sin correo")}</span>
                        </li>
                      ) : null}
                      {p.enDescanso ? (
                        <li className="flex items-center gap-2">
                          <Users size={13} className="text-muted shrink-0" />
                          <span className="tabular-nums font-medium">{p.enDescanso}</span>
                          <span className="text-muted">
                            {p.descansoNota ?? t("ya recibieron correo esta semana")}
                          </span>
                        </li>
                      ) : null}
                      {p.yaTocados ? (
                        <li className="flex items-center gap-2">
                          <AlertTriangle size={13} className="text-muted shrink-0" />
                          <span className="tabular-nums font-medium">{p.yaTocados}</span>
                          <span className="text-muted">{t("ya recibieron 2 intentos — se paran ahí")}</span>
                        </li>
                      ) : null}
                    </ul>
                  ) : null}

                  <div className="h-px bg-border my-4" />

                  <label className="block text-xs font-semibold uppercase tracking-wide text-muted mb-1.5">
                    {t("Asunto")}
                  </label>
                  <input
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    placeholder={t("Una idea para su salón")}
                    className="w-full bg-surface-2 border border-border rounded-xl px-3 py-2.5 text-sm outline-none focus:border-brand"
                  />

                  <label className="block text-xs font-semibold uppercase tracking-wide text-muted mt-4 mb-1.5">
                    {t("Qué columna es el mensaje")}
                  </label>
                  {data.mensajes.length ? (
                    <select
                      value={messageKey}
                      onChange={(e) => setMessageKey(e.target.value)}
                      className="w-full bg-surface-2 border border-border rounded-xl px-3 py-2.5 text-sm outline-none focus:border-brand"
                    >
                      {data.mensajes.map((m) => (
                        <option key={m.key} value={m.key}>
                          {m.label}{m.escrita ? "" : ` — ${t("no es un mensaje escrito")}`}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <p className="text-xs text-muted">
                      {t("Todavía no hay mensaje. Pídele al agente «arma el mensaje base» o crea una columna con")}{" "}
                      <span className="text-ink font-medium">{t("Enriquecer → Escribir un mensaje investigado")}</span>.
                    </p>
                  )}

                  {p.muestra.length ? (
                    <>
                      <div className="text-xs font-semibold uppercase tracking-wide text-muted mt-4 mb-1.5">
                        {t("A quiénes primero")}
                      </div>
                      <ul className="text-xs text-muted flex flex-col gap-1">
                        {p.muestra.map((m) => (
                          <li key={m.rowId} className="truncate">
                            <span className="text-ink">{m.name ?? "—"}</span> · {m.email}
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}

                  {/* Ver el correo y mandarse una prueba: el paso que todos los players
                      ponen antes de lanzar. */}
                  {messageKey ? (
                    <div className="flex items-center gap-2 mt-4 flex-wrap">
                      <button
                        onClick={() => verPreview(false)}
                        className="inline-flex items-center gap-1.5 text-xs font-medium border border-border rounded-lg px-3 py-2 hover:bg-surface-3"
                      >
                        <Eye size={13} /> {t("Ver el correo")}
                      </button>
                      <button
                        onClick={() => verPreview(true)}
                        disabled={probando}
                        className="inline-flex items-center gap-1.5 text-xs font-medium border border-border rounded-lg px-3 py-2 hover:bg-surface-3 disabled:opacity-50"
                      >
                        {probando ? t("Mandando…") : t("Mandarme una prueba")}
                      </button>
                      {pruebaOk ? (
                        <span className="text-xs text-emerald-500 truncate">
                          {t("Te la mandé a")} {pruebaOk}
                        </span>
                      ) : null}
                    </div>
                  ) : null}

                  {messageKey && data.mensajes.find((m) => m.key === messageKey)?.escrita === false ? (
                    <p className="text-xs text-amber-500 mt-2 flex items-start gap-1.5">
                      <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                      {t("Esa columna no la escribió el agente: el cuerpo del correo va a ser su valor tal cual. Míralo con «Ver el correo».")}
                    </p>
                  ) : null}

                  {/* Sin número, el correo sale sin su botón: o sea, sin el paso que
                      convierte un correo en una conversación. Se dice ANTES de mandar. */}
                  {sinBoton ? (
                    <p className="text-xs text-amber-500 mt-3 flex items-start gap-1.5">
                      <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                      {t("Sin WhatsApp configurado: estos correos saldrían sin su botón. Ponlo en la pantalla de listas.")}
                    </p>
                  ) : null}

                  <AnimatePresence>
                    {preview ? (
                      <motion.div
                        initial={still ? false : { opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        className="overflow-hidden mt-3"
                      >
                        <div className="flex items-center gap-2 text-[11px] text-muted mb-1.5">
                          <button onClick={() => setNth((n) => Math.max(0, n - 1))} disabled={nth <= 0} className="rounded px-1 hover:text-ink disabled:opacity-30">‹</button>
                          <span className="truncate">{nav.rowName ?? ""} · {Math.min(nth, nav.total - 1) + 1} {t("de")} {nav.total}</span>
                          <button onClick={() => setNth((n) => Math.min(nav.total - 1, n + 1))} disabled={nth >= nav.total - 1} className="rounded px-1 hover:text-ink disabled:opacity-30">›</button>
                        </div>
                        <MailPreview html={preview} marca={marca} mode="inline" />
                        {from ? <p className="text-[11px] text-muted mt-1.5">{t("Sale de")} <span className="text-ink">{from}</span></p> : null}
                      </motion.div>
                    ) : null}
                  </AnimatePresence>

                  {error ? <p className="text-xs text-red-500 mt-3">{error}</p> : null}
                </>
              )}
            </div>

            <footer className="shrink-0 flex items-center justify-end gap-2 px-5 py-4 border-t border-border">
              <button onClick={onClose} className="text-sm px-3 py-2 rounded-lg text-muted hover:bg-surface-3">
                {t("Cancelar")}
              </button>
              {/* El botón dice el número REAL, no el de la vista: es lo que va a pasar. */}
              {/* Dos clics: el primero arma, el segundo manda. Un correo no se deshace, y el
                  botón estaba a un clic de distancia del de «Ver el correo». */}
              <button
                onClick={() => { if (armado) void enviar(); else setArmado(true); }}
                disabled={!puede || sending}
                className={`inline-flex items-center gap-1.5 font-semibold text-sm rounded-lg px-4 py-2 hover:brightness-110 disabled:opacity-50 ${armado ? "bg-red-600 text-white" : "bg-brand text-brand-fg"}`}
              >
                <Send size={13} />
                {sending ? t("Mandando…") : armado ? `${t("¿Seguro? Mandar")} ${p?.irian.toLocaleString("es-MX") ?? ""} ${t("ahora")}` : `${t("Mandar")} ${p?.irian.toLocaleString("es-MX") ?? ""}`}
              </button>
            </footer>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
