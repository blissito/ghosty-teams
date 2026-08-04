import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { FileText, ExternalLink, Copy, Check, ArrowLeft, MessageSquare } from "lucide-react";
import { useLocale, useT } from "../i18n";
import { intlLocale } from "../i18n.core";
import { me } from "../server/auth";
import { listTeamFormsFn, setFormFichaModeFn } from "../server/forms";

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
    <div className="min-h-screen bg-bg text-ink">
      <div className="max-w-3xl mx-auto px-5 py-8">
        <Link to="/c/$slug" params={{ slug: "general" }} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink mb-4">
          <ArrowLeft size={15} /> {t("Volver al chat")}
        </Link>
        <header className="mb-6">
          <h1 className="text-2xl font-bold flex items-center gap-2"><FileText size={22} className="text-brand" /> {t("Formularios")}</h1>
          <p className="text-muted text-sm mt-1">
            {t("Formularios de intake de tus expedientes. Las respuestas caen en el room del cliente, en una hoja que crece con cada envío.")}
          </p>
        </header>

        {forms === null ? (
          <ul className="flex flex-col gap-3">
            {[0, 1, 2].map((i) => (
              <li key={i} className="border border-border bg-surface-2 rounded-2xl p-4 flex items-center gap-4 animate-pulse">
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
            <p className="font-semibold text-ink mb-1">{t("Aún no hay formularios en tus expedientes")}</p>
            <p>{t("Pídele a")} <span className="text-brand">@ghosty</span> {t("“crea un formulario de diagnóstico” en el room del cliente.")}</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {forms.map((f) => (
              <li key={f.formId} className="border border-border bg-surface-2 rounded-2xl p-4 flex flex-wrap items-center gap-x-4 gap-y-2">
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
                    title={t("Ver las respuestas en el room del expediente")}
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
