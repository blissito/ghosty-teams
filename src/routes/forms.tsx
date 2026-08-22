import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { FileText, ExternalLink, Copy, Check, ArrowLeft, MessageSquare, Send } from "lucide-react";
import { useLocale, useT } from "../i18n";
import { intlLocale } from "../i18n.core";
import { me } from "../server/auth";
import { formHookActionFn, listFormHooksFn, listTeamFormsFn, setFormFichaModeFn } from "../server/forms";

// Cache a nivel de módulo: re-entrar a /forms es instantáneo (sin skeleton si ya se vio).
type FormRow = Awaited<ReturnType<typeof listTeamFormsFn>>[number];
let formsCache: FormRow[] | null = null;

export const Route = createFileRoute("/forms")({
  // El loader SOLO resuelve auth (rápido) → navegar a /forms es instantáneo; la lista
  // se carga client-side con skeleton (optimista), no bloquea la navegación.
  loader: async () => ({ user: await me() }),
  component: FormsPage,
});

function fmtDate(ts: number | null, locale: string): string {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleDateString(locale, { day: "numeric", month: "short" });
}

function FormsPage() {
  const t = useT();
  const locale = useLocale();
  const [forms, setForms] = useState<FormRow[] | null>(formsCache);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    listTeamFormsFn()
      .then((f) => { if (!alive) return; formsCache = f; setForms(f); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // Optimista y sin recargar la lista: es un interruptor, y esperar medio segundo a que
  // vuelva el servidor para que se mueva se siente roto. Si falla, se regresa solo.
  const toggleFicha = (f: FormRow) => {
    const mode = f.fichaMode === "auto" ? "off" : "auto";
    const pintar = (m: "off" | "auto") =>
      setForms((prev) => {
        const next = (prev ?? []).map((x) => (x.formId === f.formId ? { ...x, fichaMode: m } : x));
        formsCache = next;
        return next;
      });
    pintar(mode);
    setFormFichaModeFn({ data: { formId: f.formId, mode } })
      .then((r) => { if (!r.ok) pintar(f.fichaMode); })
      .catch(() => pintar(f.fichaMode));
  };

  const copy = (url: string, id: string) => {
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
    });
  };

  return (
    <div className="min-h-screen bg-surface text-ink">
      <div className="max-w-3xl mx-auto px-5 py-8">
        <Link to="/c/$slug" params={{ slug: "general" }} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink mb-4">
          <ArrowLeft size={15} /> {t("Volver al chat")}
        </Link>
        <header className="mb-6">
          <h1 className="text-2xl font-bold flex items-center gap-2"><FileText size={22} className="text-brand" /> {t("Formularios")}</h1>
          <p className="text-muted text-sm mt-1">
            {t("Los formularios que reparte tu equipo. Las respuestas caen en su room, en una hoja que crece con cada envío.")}
          </p>
        </header>

        {forms === null ? (
          <ul className="flex flex-col gap-3">
            {[0, 1, 2].map((i) => (
              <li key={i} className="gt-card rounded-2xl p-4 flex items-center gap-4 animate-pulse">
                <div className="flex-1">
                  <div className="h-4 w-2/3 bg-surface-3 rounded mb-2" />
                  <div className="h-3 w-1/3 bg-surface-3 rounded" />
                </div>
                <div className="h-8 w-16 bg-surface-3 rounded" />
                <div className="h-8 w-20 bg-surface-3 rounded-lg" />
              </li>
            ))}
          </ul>
        ) : forms.length === 0 ? (
          <div className="border border-dashed border-border rounded-2xl p-10 text-center text-muted text-sm">
            <p className="font-semibold text-ink mb-1">{t("Todavía no hay formularios")}</p>
            <p>{t("Pídele a")} <span className="text-brand">@ghosty</span> {t("“arma un formulario para dar de alta clientes” en el room donde quieras las respuestas.")}</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {forms.map((f) => (
              <li key={f.formId} className="gt-card rounded-2xl p-4 flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className="flex-1 min-w-[200px]">
                  <div className="font-semibold text-[15px]">{f.name}</div>
                  <div className="text-xs text-muted mt-1 flex items-center gap-3 flex-wrap">
                    {f.roomName ? <span className="inline-flex items-center gap-1"><MessageSquare size={12} /> {f.roomName}</span> : null}
                    {f.lastSubmittedAt ? <span>{t("última:")} {fmtDate(f.lastSubmittedAt, intlLocale(locale))}</span> : null}
                  </div>
                </div>
                {f.roomSlug ? (
                  <Link
                    to="/c/$slug"
                    params={{ slug: f.roomSlug }}
                    title={t("Ver las respuestas en su room")}
                    className="text-center px-3 py-1 rounded-lg hover:bg-surface-3"
                  >
                    <div className="text-xl font-bold text-brand tabular-nums">{f.submissions}</div>
                    <div className="text-[10px] uppercase tracking-wide text-muted">{t("respuestas")} ↗</div>
                  </Link>
                ) : (
                  <div className="text-center px-3">
                    <div className="text-xl font-bold text-brand tabular-nums">{f.submissions}</div>
                    <div className="text-[10px] uppercase tracking-wide text-faint">{t("respuestas")}</div>
                  </div>
                )}
                {f.url ? (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => copy(f.url!, f.formId)}
                      className="inline-flex items-center gap-1.5 text-xs font-medium border border-border rounded-lg px-3 py-2 hover:bg-surface-3"
                    >
                      {copied === f.formId ? <><Check size={13} /> {t("Copiado")}</> : <><Copy size={13} /> {t("Copiar liga")}</>}
                    </button>
                    <a
                      href={f.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 text-xs font-semibold bg-brand text-brand-fg rounded-lg px-3 py-2 hover:brightness-110"
                    >
                      <ExternalLink size={13} /> {t("Abrir")}
                    </a>
                  </div>
                ) : (
                  <span className="text-xs text-faint italic">{t("sin liga")}</span>
                )}
                <Destinos formId={f.formId} />
                <label
                  title={t("Publica el documento de cada respuesta en el hilo del formulario. Sólo de aquí en adelante.")}
                  className="w-full flex items-center gap-2 text-xs text-muted cursor-pointer select-none pt-1"
                >
                  <input
                    type="checkbox"
                    checked={f.fichaMode === "auto"}
                    onChange={() => toggleFicha(f)}
                    className="accent-brand"
                  />
                  {t("Una ficha por respuesta")}
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Los destinos de un formulario: a qué otro sistema van sus respuestas.
 *
 * Se pide al ABRIR, no con la página: cada formulario es una consulta más, y casi ningún
 * workspace tiene destinos. Cerrado no cuesta nada.
 *
 * ⚠️ Activar un destino manda un intake a un tercero, así que es un gesto del dueño y no del
 * agente: la tool `form_webhook` sólo propone la URL y lo deja apagado. El alta desde aquí
 * hace las dos cosas de un tirón —ya hay sesión y acaba de teclear la URL—, pero pasa por el
 * mismo ping firmado: una URL con errata se queda apagada con el motivo escrito.
 */
function Destinos({ formId }: { formId: string }) {
  const t = useT();
  type Hook = Awaited<ReturnType<typeof listFormHooksFn>>[number];
  const [abierto, setAbierto] = useState(false);
  const [hooks, setHooks] = useState<Hook[] | null>(null);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const recargar = () => listFormHooksFn({ data: { formId } }).then(setHooks).catch(() => setHooks([]));
  useEffect(() => { if (abierto && hooks === null) void recargar(); }, [abierto]);

  const actuar = (d: Parameters<typeof formHookActionFn>[0]["data"]) => {
    setOcupado(true);
    setError(null);
    formHookActionFn({ data: d })
      .then((r) => { if (!r.ok) setError(r.error); else setUrl(""); return recargar(); })
      .catch(() => setError(t("No se pudo. Inténtalo otra vez.")))
      .finally(() => setOcupado(false));
  };

  return (
    <div className="w-full">
      <button
        onClick={() => setAbierto((v) => !v)}
        className="text-xs text-muted hover:text-ink inline-flex items-center gap-1.5"
      >
        <Send size={12} /> {t("Enviar a otro sistema")}
        {hooks?.some((h) => h.enabled) ? <span className="text-brand">•</span> : null}
      </button>
      {abierto ? (
        <div className="mt-2 border border-border rounded-xl p-3 flex flex-col gap-2 bg-surface">
          {hooks === null ? (
            <div className="h-4 w-1/2 bg-surface-3 rounded animate-pulse" />
          ) : (
            hooks.map((h) => (
              <div key={h.id} className="text-xs flex flex-wrap items-center gap-2">
                <span className={h.enabled ? "text-emerald-500" : "text-faint"}>{h.enabled ? "●" : "○"}</span>
                <span className="font-mono flex-1 min-w-[160px] break-all">{h.url}</span>
                <button
                  disabled={ocupado}
                  onClick={() => actuar({ formId, op: h.enabled ? "disable" : "enable", hookId: h.id })}
                  className="border border-border rounded px-2 py-1 hover:bg-surface-3"
                >
                  {h.enabled ? t("Desconectar") : t("Activar")}
                </button>
                <button
                  disabled={ocupado}
                  onClick={() => actuar({ formId, op: "delete", hookId: h.id })}
                  className="text-muted hover:text-red-500 px-1"
                >
                  {t("Quitar")}
                </button>
                {/* El secreto con el que el otro lado verifica la firma. Se enseña completo
                    a propósito: es lo único de aquí que hay que copiar a otro sistema. */}
                <code className="w-full text-[10px] text-muted break-all">
                  {t("secreto:")} {h.secret}
                </code>
                {h.disabledReason && !h.enabled ? (
                  <p className="w-full text-[11px] text-muted">{h.disabledReason}</p>
                ) : null}
              </div>
            ))
          )}
          <div className="flex gap-2">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
              className="flex-1 text-xs border border-border rounded-lg px-2 py-1.5 bg-surface-2"
            />
            <button
              disabled={ocupado || !url.trim()}
              onClick={() => actuar({ formId, op: "add", url: url.trim() })}
              className="text-xs font-semibold bg-brand text-brand-fg rounded-lg px-3 py-1.5 disabled:opacity-50"
            >
              {t("Conectar")}
            </button>
          </div>
          {error ? <p className="text-[11px] text-red-500">{error}</p> : null}
          <p className="text-[11px] text-muted">
            {t("Cada respuesta se manda como POST firmado. Comprobamos que conteste antes de activarlo.")}
          </p>
        </div>
      ) : null}
    </div>
  );
}
