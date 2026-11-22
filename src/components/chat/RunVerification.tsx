// «Verificación» del pedido de la fábrica (22-nov), porte de la pestaña de Desarrollo de gs: el smoke completo que corre
// gs contra la preview (rutas, página y Lighthouse) más el CI del PR. En la tarjeta va como renglón de chips con lo
// concreto que falla y «Pedir arreglo al agente»; el detalle abre un panel lateral en portal (el room sigue a la vista).
// Una sola pieza de smoke: los datos salen de gs (`POST /api/v2/partners/smoke` con `full`), aquí sólo se pintan.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight, ExternalLink, X } from "lucide-react";
import { useT } from "../../i18n";
import { factorySmokeFixFn } from "../../server/apps/factory";

type Issue = { kind: "image" | "layout" | "contrast"; what: string; where: string };
type Step = { path: string; method: "GET" | "POST"; status: number | null; ok: boolean; why: string };
export type RunSmoke = {
  sha: string | null;
  ok: boolean;
  results: Step[] | null;
  page: { brokenImages: number; layout: number; contrastFails: number; contrastRan: boolean; issues?: Issue[] } | null;
  lighthouse: { performance: number | null; accessibility: number | null; bestPractices: number | null; seo: number | null } | null;
  at: number | null;
} | null;
type CiCheck = { name: string; state: "success" | "failure" | "pending" | "neutral"; seconds: number | null; url: string | null };
type Ci = { state: string; checks: CiCheck[] } | null;

/** Los chips son tan vivos como el pedido: sin smoke todavía, nada. */
const pageCount = (s: RunSmoke) => (s?.page ? s.page.brokenImages + s.page.layout + (s.page.contrastRan ? s.page.contrastFails : 0) : 0);
const routeFails = (s: RunSmoke) => (s?.results ?? []).filter((r) => !r.ok);
/** Lo que se puede pedir arreglar (rutas que truenan o hallazgos de la página). */
export const smokeHasFix = (s: RunSmoke) => routeFails(s).length > 0 || pageCount(s) > 0;
// Ghosty primero: lo nuestro (Smoke, Review, Preview…) separado del CI del repo, como en gs.
const isGhosty = (name: string) => /^ghosty\b/i.test(name);

function Chip({ tone, children, title }: { tone: "ok" | "bad" | "muted"; children: React.ReactNode; title?: string }) {
  const cls =
    tone === "ok"
      ? "border-emerald-600/40 text-emerald-700 dark:text-emerald-300"
      : tone === "bad"
        ? "border-red-600/40 text-red-700 dark:text-red-300"
        : "border-border text-muted";
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${cls}`}>
      {children}
    </span>
  );
}

function lhShort(l: NonNullable<RunSmoke>["lighthouse"]) {
  if (!l) return null;
  const f = (n: number | null) => (n == null ? "–" : String(n));
  return `R ${f(l.performance)} · A ${f(l.accessibility)} · P ${f(l.bestPractices)} · SEO ${f(l.seo)}`;
}

/** El renglón del smoke dentro de la tarjeta: chips, lo que falla (máx. 3) y las dos acciones. */
export function SmokeStrip(props: { runId: number; title: string; smoke: RunSmoke; ci: Ci; prUrl: string | null; live: boolean; onChanged: () => void }) {
  const t = useT();
  const { smoke } = props;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (!smoke) return null;
  const fails = routeFails(smoke);
  const issues = (smoke.page?.issues ?? []).filter((i) => i.kind !== "contrast" || smoke.page?.contrastRan);
  const count = fails.length + pageCount(smoke);
  const lh = lhShort(smoke.lighthouse);
  const fix = async () => {
    setBusy(true);
    setErr("");
    try {
      await factorySmokeFixFn({ data: { runId: props.runId } });
      props.onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {count ? (
          <Chip tone="bad">
            <X size={12} aria-hidden /> {t("Smoke: {n} fallas").replace("{n}", String(count))}
          </Chip>
        ) : (
          <Chip tone="ok">
            <Check size={12} aria-hidden /> {t("Smoke en verde")}
          </Chip>
        )}
        {lh ? (
          <Chip tone="muted" title={t("Lighthouse contra la vista previa: Rendimiento, Accesibilidad, Buenas prácticas y SEO")}>
            Lighthouse {lh}
          </Chip>
        ) : null}
      </div>
      {count ? (
        <ul className="mt-1.5 space-y-0.5 rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-ink">
          {[...fails.map((f) => `${f.method} ${f.path} · ${f.why}`), ...issues.map((i) => `${i.what}${i.where ? ` · ${i.where}` : ""}`)].slice(0, 3).map((line, i) => (
            <li key={i} className="break-words">{line}</li>
          ))}
          {count > 3 ? <li className="text-muted">{t("y {n} más en «Ver verificación»").replace("{n}", String(count - 3))}</li> : null}
        </ul>
      ) : null}
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        {count && props.live ? (
          <button
            type="button"
            disabled={busy}
            onClick={fix}
            className="rounded-full bg-brand px-3 py-1 text-xs font-bold text-white hover:opacity-90 disabled:opacity-50"
          >
            {t("Pedir arreglo al agente")}
          </button>
        ) : null}
        <button type="button" onClick={() => setOpen(true)} className="rounded-full border border-border px-3 py-1 text-xs font-semibold text-ink hover:bg-surface-3">
          {t("Ver verificación")}
        </button>
      </div>
      {err ? <p className="mt-1 text-xs text-red-600 dark:text-red-400">{err}</p> : null}
      {open ? <VerificationPanel {...props} onClose={() => setOpen(false)} onFix={count && props.live ? fix : null} busy={busy} /> : null}
    </div>
  );
}

function Gauge({ value, label }: { value: number | null; label: string }) {
  const v = value ?? 0;
  const color = value == null ? "var(--color-border, #444)" : v >= 90 ? "#10b981" : v >= 50 ? "#f59e0b" : "#ef4444";
  const r = 22;
  const c = 2 * Math.PI * r;
  return (
    <figure className="flex flex-col items-center gap-1" aria-label={`${label}: ${value ?? "—"}`}>
      <svg width="56" height="56" viewBox="0 0 56 56" aria-hidden>
        <circle cx="28" cy="28" r={r} fill="none" stroke="currentColor" strokeOpacity="0.12" strokeWidth="5" />
        <circle cx="28" cy="28" r={r} fill="none" stroke={color} strokeWidth="5" strokeLinecap="round" strokeDasharray={`${(v / 100) * c} ${c}`} transform="rotate(-90 28 28)" />
        <text x="28" y="33" textAnchor="middle" fontSize="15" fontWeight="700" fill={color}>
          {value ?? "—"}
        </text>
      </svg>
      <figcaption className="text-[11px] text-muted">{label}</figcaption>
    </figure>
  );
}

function Card({ ok, label, value }: { ok: boolean | null; label: string; value: string }) {
  const tone = ok === null ? "border-border" : ok ? "border-emerald-600/40" : "border-red-600/40";
  return (
    <div className={`rounded-lg border ${tone} px-3 py-2`}>
      <p className="flex items-center gap-1 text-[11px] text-muted">
        {ok === null ? null : ok ? <Check size={12} className="text-emerald-600" aria-hidden /> : <X size={12} className="text-red-600" aria-hidden />}
        {label}
      </p>
      <p className="text-sm font-semibold text-ink">{value}</p>
    </div>
  );
}

function IssueGroup({ title, items }: { title: string; items: Issue[] }) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  return (
    <div className="rounded-lg border border-border">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-1 px-3 py-2 text-left text-xs font-semibold text-ink">
        <ChevronRight size={14} className={`transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />
        {title}
      </button>
      {open ? (
        <ul className="space-y-1 border-t border-border px-3 py-2 font-mono text-[11px] text-muted">
          {items.map((i, k) => (
            <li key={k} className="break-all">
              {i.what}
              {i.where ? <span className="text-muted/80"> · {i.where}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function CiList({ title, checks }: { title: string; checks: CiCheck[] }) {
  if (!checks.length) return null;
  const green = checks.filter((c) => c.state === "success").length;
  return (
    <div>
      <p className="flex justify-between text-xs font-semibold text-ink">
        {title}
        <span className="font-normal text-muted">{green ? `${green} ✓` : ""}</span>
      </p>
      <ul className="mt-1 divide-y divide-border rounded-lg border border-border">
        {checks.map((c) => (
          <li key={c.name} className="flex items-center gap-2 px-3 py-1.5 text-xs">
            {c.state === "success" ? <Check size={13} className="text-emerald-600" aria-hidden /> : c.state === "failure" ? <X size={13} className="text-red-600" aria-hidden /> : <span className="inline-block h-2 w-2 rounded-full bg-amber-500" aria-hidden />}
            <span className="min-w-0 flex-1 truncate text-ink">{c.name}</span>
            {c.url ? (
              <a href={c.url} target="_blank" rel="noreferrer" className="text-muted hover:text-ink" aria-label={c.name}>
                <ExternalLink size={12} />
              </a>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** El detalle, en un panel por la derecha (portal al body: ningún `overflow` de la tarjeta lo recorta). */
export function VerificationPanel(props: { title: string; runId: number; smoke: RunSmoke; ci: Ci; prUrl: string | null; onClose: () => void; onFix: (() => void) | null; busy: boolean }) {
  const t = useT();
  const { smoke, ci } = props;
  const [skippedOpen, setSkippedOpen] = useState(false);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [props.onClose]);
  const l = smoke?.lighthouse ?? null;
  const fails = routeFails(smoke);
  const issues = smoke?.page?.issues ?? [];
  const checks = ci?.checks ?? [];
  const skipped = checks.filter((c) => c.state === "neutral");
  const active = checks.filter((c) => c.state !== "neutral");
  const ciRed = checks.some((c) => c.state === "failure");
  const prNum = props.prUrl?.match(/\/pull\/(\d+)/)?.[1];
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={t("Verificación")}>
      <button type="button" aria-label={t("Cerrar")} onClick={props.onClose} className="absolute inset-0 bg-black/30" />
      <aside className="relative flex h-full w-full max-w-[620px] flex-col overflow-y-auto border-l border-border bg-surface shadow-xl">
        <header className="sticky top-0 z-10 flex items-start gap-3 border-b border-border bg-surface px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold text-ink">{t("Verificación")}</h2>
            <p className="truncate text-xs text-muted">
              #{props.runId} · {props.title}
              {prNum ? ` · PR #${prNum}` : ""}
            </p>
          </div>
          <button type="button" onClick={props.onClose} aria-label={t("Cerrar")} className="rounded-full p-1.5 text-muted hover:bg-surface-3 hover:text-ink">
            <X size={18} />
          </button>
        </header>
        <div className="space-y-5 px-5 py-4">
          {l ? (
            <section aria-label="Lighthouse">
              <p className="text-sm font-semibold text-ink">Lighthouse</p>
              <div className="mt-2 grid grid-cols-4 gap-2">
                <Gauge value={l.performance} label={t("Rendimiento")} />
                <Gauge value={l.accessibility} label={t("Accesibilidad")} />
                <Gauge value={l.bestPractices} label={t("Buenas prácticas")} />
                <Gauge value={l.seo} label="SEO" />
              </div>
              <p className="mt-1 text-center text-[11px] text-muted">{t("Escritorio, contra la vista previa. 90 o más es bueno; informativo, no frena el merge.")}</p>
            </section>
          ) : null}
          <section className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Card ok={ci ? (ci.state === "pending" ? null : !ciRed) : null} label={t("CI del commit")} value={!ci ? "—" : ci.state === "pending" ? t("Corriendo") : ciRed ? t("En rojo") : t("En verde")} />
            <Card ok={smoke ? !fails.length : null} label={t("Smoke contra la vista previa")} value={!smoke ? t("Aún no corre") : fails.length ? t("{n} rutas fallan").replace("{n}", String(fails.length)) : t("Rutas en verde")} />
            <Card ok={smoke?.page ? pageCount(smoke) === 0 : null} label={t("La página")} value={!smoke?.page ? "—" : pageCount(smoke) ? t("{n} hallazgos").replace("{n}", String(pageCount(smoke))) : t("Sin hallazgos")} />
          </section>
          <section className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <p className="text-sm font-semibold text-ink">{t("Smoke contra la vista previa")}</p>
              {(smoke?.results ?? []).length ? (
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {(smoke?.results ?? []).map((r, i) => (
                    <li key={i} className="flex items-center gap-2 px-3 py-1.5 text-xs" title={r.why}>
                      {r.ok ? <Check size={13} className="text-emerald-600" aria-hidden /> : <X size={13} className="text-red-600" aria-hidden />}
                      <span className="rounded bg-surface-3 px-1 font-mono text-[10px] text-muted">{r.method}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-ink">{r.path}</span>
                      <span className="text-muted">{r.status ?? "—"}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted">{t("Sin rutas que probar.")}</p>
              )}
              {smoke?.page ? (
                <>
                  <IssueGroup title={t("{n} imágenes rotas").replace("{n}", String(smoke.page.brokenImages))} items={issues.filter((i) => i.kind === "image")} />
                  <IssueGroup title={t("{n} desbordes o texto cortado").replace("{n}", String(smoke.page.layout))} items={issues.filter((i) => i.kind === "layout")} />
                  {smoke.page.contrastRan ? (
                    <IssueGroup title={t("{n} fallas de contraste").replace("{n}", String(smoke.page.contrastFails))} items={issues.filter((i) => i.kind === "contrast")} />
                  ) : null}
                </>
              ) : null}
              <p className="text-[11px] text-muted">{t("Sólo frena el merge que una ruta truene o rechace envíos.")}</p>
              {props.onFix ? (
                <button type="button" disabled={props.busy} onClick={props.onFix} className="rounded-full bg-brand px-3 py-1 text-xs font-bold text-white hover:opacity-90 disabled:opacity-50">
                  {t("Pedir arreglo al agente")}
                </button>
              ) : null}
            </div>
            <div className="space-y-3">
              <p className="text-sm font-semibold text-ink">{t("CI del commit")}</p>
              {active.length ? (
                <>
                  <CiList title={t("De Ghosty")} checks={active.filter((c) => isGhosty(c.name))} />
                  <CiList title={t("CI del repo")} checks={active.filter((c) => !isGhosty(c.name))} />
                </>
              ) : (
                <p className="text-xs text-muted">{t("Este PR todavía no tiene checks.")}</p>
              )}
              {skipped.length ? (
                <div>
                  <button type="button" onClick={() => setSkippedOpen((o) => !o)} className="flex items-center gap-1 text-xs text-muted hover:text-ink">
                    <ChevronRight size={14} className={`transition-transform ${skippedOpen ? "rotate-90" : ""}`} aria-hidden />
                    {t("{n} no aplicaron").replace("{n}", String(skipped.length))}
                  </button>
                  {skippedOpen ? <CiList title="" checks={skipped} /> : null}
                </div>
              ) : null}
            </div>
          </section>
        </div>
      </aside>
    </div>,
    document.body,
  );
}
