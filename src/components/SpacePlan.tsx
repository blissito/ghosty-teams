import { useEffect, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { ArrowRight, ArrowUpRight, Check, Factory, Handshake, Lock, ShoppingBag, Sparkles, X } from "lucide-react";
import { useT } from "../i18n";
import { spaceStatusFn } from "../server/workspaces";
import { cachedMe } from "../server/auth";

// «Space cerrado» y la franja de días de prueba.
//
// La verdad del plan vive en gs: aquí sólo se pinta lo que `spaceStatusFn` trae y se manda
// al dueño al Checkout de gs, que regresa a este espacio. Nada se borra ni se esconde más
// allá de esta pantalla: los rooms, documentos y agentes siguen intactos detrás.

export type SpaceStatus = {
  slug: string;
  plan: string;
  isTrial: boolean;
  trialEndsAt: string | null;
  trialExpired: boolean;
  /** Oferta del primer mes (la arma gs; null o ausente = precio normal). */
  offer?: SpaceOffer | null;
  /** Nació cerrado porque el dueño ya usó su prueba en otro Space. */
  bornClosed?: boolean;
  /** Días que quedan, resueltos por gs (null si no es prueba). */
  daysLeft: number | null;
  /** Plan del espacio en gs; `checkoutUrl` va directo a Stripe si lo abre el dueño. */
  payUrl: string;
  checkoutUrl: string;
  studioUrl: string;
  /** Módulos debajo del Space, armados por gs con su cotizador (MXN al mes, IVA incluido). */
  modules?: SpaceModule[];
};

export type SpaceModule = { key: string; name: string; fromMxn: number | null; href: string };

/** Respaldo si gs todavía no manda `modules`: los mismos números que cotiza gs hoy (F1 $1,897
 *  dentro de `quote()`, Ventas $890 + IVA = $1,032) y la liga de llamada de Partner de /planes. */
const FALLBACK_MODULES: SpaceModule[] = [
  { key: "factory", name: "Factory", fromMxn: 1897, href: "https://www.ghosty.studio/planes?factory=F1" },
  { key: "sales", name: "Sales", fromMxn: 1032, href: "https://www.ghosty.studio/planes?p=sales#planes" },
  {
    key: "partner",
    name: "Partner",
    fromMxn: null,
    href: "https://wa.me/527717759013?text=%C2%A1Hola!%20Quiero%20agendar%20una%20llamada%20para%20ser%20Partner%20de%20Ghosty.",
  },
];
const MODULE_ICON: Record<string, React.ReactNode> = {
  factory: <Factory size={16} />,
  sales: <ShoppingBag size={16} />,
  partner: <Handshake size={16} />,
};

/** Precio del Space en MXN al mes. Es el MISMO número que cobra gs (`quote()`); si allá
 *  cambia, cambia aquí. */
export const SPACE_PRICE = 690;

export type SpaceOffer = { percent: number; firstMonth: number; until: string };

/** La oferta sólo cuenta si trae precio y no ha vencido: con reloj de por medio, gs puede
 *  mandarla un rato después de su fecha y no queremos anunciar algo que ya no cobra. */
export function activeOffer(o: SpaceOffer | null | undefined, now = Date.now()): SpaceOffer | null {
  if (!o || !(o.firstMonth > 0) || !(o.firstMonth < SPACE_PRICE)) return null;
  const until = new Date(o.until).getTime();
  return Number.isFinite(until) && until > now ? o : null;
}

/** «7 de noviembre» (largo) o «7-nov» (corto), en hora de CDMX. Se resta 1 ms: si gs
 *  manda el fin exclusivo (8-nov 00:00), el último día que vale sigue siendo el 7. */
function offerDate(iso: string, short = false): string {
  const d = new Date(new Date(iso).getTime() - 1);
  if (short) {
    const day = d.toLocaleDateString("es-MX", { day: "numeric", timeZone: "America/Mexico_City" });
    const month = d.toLocaleDateString("es-MX", { month: "short", timeZone: "America/Mexico_City" }).replace(/\.$/, "");
    return `${day}-${month}`;
  }
  return d.toLocaleDateString("es-MX", { day: "numeric", month: "long", timeZone: "America/Mexico_City" });
}

/** Días enteros que le quedan a la prueba (redondeo hacia arriba: a 30 h son «2 días»). */
export function daysLeft(endsAt: string | null, now = Date.now()): number | null {
  if (!endsAt) return null;
  const ms = new Date(endsAt).getTime() - now;
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

const fmt = (n: number) => `$${n.toLocaleString("es-MX")}`;

// ── Estado compartido ────────────────────────────────────────────────────────────────
// Una sola consulta por pestaña: la pantalla y la franja leen lo mismo. Se refresca al
// volver a la pestaña (el dueño pudo pagar en otra) y cada 10 min.
let cache: SpaceStatus | null | undefined;
const listeners = new Set<(s: SpaceStatus | null) => void>();
let inflight: Promise<void> | null = null;

function refresh() {
  if (inflight) return inflight;
  inflight = spaceStatusFn()
    .then((s) => {
      cache = s;
      listeners.forEach((l) => l(s));
    })
    .catch(() => {})
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function useSpaceStatus(enabled = true): SpaceStatus | null {
  const [s, setS] = useState<SpaceStatus | null>(cache ?? null);
  useEffect(() => {
    if (!enabled) return;
    listeners.add(setS);
    if (cache === undefined) refresh();
    const onVis = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVis);
    const id = window.setInterval(refresh, 10 * 60_000);
    return () => {
      listeners.delete(setS);
      document.removeEventListener("visibilitychange", onVis);
      window.clearInterval(id);
    };
  }, [enabled]);
  return enabled ? s : null;
}

// ── Cards ────────────────────────────────────────────────────────────────────────────

/** La mascota oficial, tal cual (sin repintar ni placa de fondo): el mismo archivo que
 *  `ghosty-studio/public/mascot.png`. */
const MASCOT_URL = "/mascot.png";

// Paleta de marca de Ghosty (ghosty-studio/app/app.css). El violeta de Teams (`brand`) es
// el tema configurable del workspace, no la marca: aquí se habla de dinero y va la marca.
// #191A20 sobre #9A99EA da ~7:1 (AA) y sirve igual en claro y oscuro.
const CTA = "bg-[#9A99EA] text-[#191A20] hover:bg-[#8483E0]";
const ACCENT = "text-[#8483E0]";

/** Card protagonista: el Space. Es lo único que se cobra hoy. */
export function SpaceCard({ cta, offer }: { cta?: React.ReactNode; offer?: SpaceOffer | null }) {
  const t = useT();
  const o = activeOffer(offer);
  const perks = [
    t("Rooms, hilos y documentos de todo tu equipo"),
    t("Tus agentes trabajando con el equipo"),
    t("Saldo aparte o con tu propia llave"),
  ];
  return (
    <div className="rounded-3xl border border-border bg-card p-6 shadow-[0_24px_60px_-36px_rgba(25,26,32,0.35)] sm:p-8">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-base font-semibold text-ink">Space</p>
        <p className="text-xs text-muted">{t("Ghosty Teams completo")}</p>
      </div>
      {o ? (
        <>
          <p className="mt-4 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-lg font-medium text-muted line-through decoration-1">{fmt(SPACE_PRICE)}</span>
            <span className="text-5xl font-bold tracking-tight text-ink">{fmt(o.firstMonth)}</span>
            <span className="text-sm text-muted">{t("tu primer mes")}</span>
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#9A99EA]/15 px-2.5 py-1 text-xs font-medium text-ink">
              <Sparkles size={12} className={ACCENT} />
              {t("Oferta hasta el {date}", { date: offerDate(o.until) })}
            </span>
            <span className="text-xs text-muted">{t("luego {price} al mes", { price: fmt(SPACE_PRICE) })} · {t("IVA incluido")}</span>
          </div>
        </>
      ) : (
        <p className="mt-4 flex items-baseline gap-1.5">
          <span className="text-5xl font-bold tracking-tight text-ink">{fmt(SPACE_PRICE)}</span>
          <span className="text-sm text-muted">MXN {t("al mes")} · {t("IVA incluido")}</span>
        </p>
      )}
      <ul className="mt-6 space-y-3">
        {perks.map((p) => (
          <li key={p} className="flex items-start gap-3 text-sm text-ink">
            <Check size={16} strokeWidth={2.5} className={`mt-0.5 shrink-0 ${ACCENT}`} />
            {p}
          </li>
        ))}
      </ul>
      {cta && <div className="mt-8">{cta}</div>}
    </div>
  );
}

/** Factory, Sales y Partner: una fila discreta por módulo, debajo del Space (= Teams). Los
 *  precios los manda gs (`modules`, de su cotizador, IVA incluido); cada fila lleva a su liga. */
export function ModuleChips({ modules }: { modules?: SpaceModule[] }) {
  const t = useT();
  const items = modules?.length ? modules : FALLBACK_MODULES;
  return (
    <div className="space-y-2">
      {items.map((m) => (
        <a
          key={m.key}
          href={m.href}
          target={m.href.startsWith("https://wa.me/") ? "_blank" : undefined}
          rel="noreferrer"
          className="group flex items-center gap-3 rounded-2xl border border-border px-4 py-3 transition hover:border-ink/30"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-surface-3 text-muted">
            {MODULE_ICON[m.key] ?? <Sparkles size={16} />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-ink">{m.name}</p>
            <p className="text-xs text-muted">
              {m.fromMxn == null
                ? t("A tu medida · empieza con una llamada")
                : `${t("desde {price}/mes", { price: fmt(m.fromMxn) })} · ${t("IVA incluido")}`}
            </p>
          </div>
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-faint group-hover:text-ink">
            {m.fromMxn == null ? t("Agendar") : t("Agrégalo luego")}
            <ArrowUpRight size={12} />
          </span>
        </a>
      ))}
    </div>
  );
}

/** Botón de pago del dueño: Checkout de Stripe por gs, que regresa a este Space. */
export function PayButton({ status, label }: { status: SpaceStatus; label?: string }) {
  const t = useT();
  const o = activeOffer(status.offer);
  return (
    <a
      href={status.checkoutUrl}
      className={`group inline-flex w-full items-center justify-center gap-2 rounded-2xl px-5 py-3.5 text-[15px] font-semibold transition active:scale-[0.99] ${CTA}`}
    >
      {label ??
        (o
          ? t("Reactivar por {price}", { price: fmt(o.firstMonth) })
          : t("Reactivar por {price}/mes", { price: fmt(SPACE_PRICE) }))}
      <ArrowRight size={18} className="transition group-hover:translate-x-0.5" />
    </a>
  );
}

// ── Pantalla «Space cerrado» ─────────────────────────────────────────────────────────

export function SpaceClosedScreen({ status, isOwner }: { status: SpaceStatus; isOwner: boolean }) {
  const t = useT();
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="space-closed-title"
      className="fixed inset-0 z-[90] overflow-y-auto bg-surface-2 text-ink"
    >
      <div className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col px-4 pb-10 pt-[max(3.5rem,env(safe-area-inset-top))]">
        <header className="flex flex-col items-center text-center">
          <div className="relative">
            <img src={MASCOT_URL} alt="Ghosty" width={72} height={86} className="h-[86px] w-[72px] object-contain" />
            <span className="absolute -bottom-1 -right-3 flex h-7 w-7 items-center justify-center rounded-full border border-border bg-card text-muted shadow-sm">
              <Lock size={13} />
            </span>
          </div>
          <h1 id="space-closed-title" className="mt-7 text-balance text-2xl font-bold tracking-tight sm:text-[28px]">
            {!isOwner
              ? t("Este espacio está en pausa")
              : status.bornClosed
                ? t("Este espacio se abre con su plan")
                : t("Tu prueba terminó, elige tu plan")}
          </h1>
          <p className="mt-2 text-[15px] text-muted">
            {isOwner
              ? status.bornClosed
                ? t("Tu prueba ya la usaste en otro espacio.")
                : t("Tus rooms, documentos y agentes siguen aquí.")
              : `${t("El dueño tiene que reactivar este espacio.")} ${t("Tus rooms, documentos y agentes siguen aquí.")}`}
          </p>
        </header>

        {isOwner ? (
          <>
            <section className="mt-10">
              <SpaceCard offer={status.offer} cta={<PayButton status={status} />} />
            </section>
            <section className="mt-8">
              <ModuleChips modules={status.modules} />
            </section>
          </>
        ) : null}

        <footer className="mt-auto pt-12 text-center">
          <a href={`${status.studioUrl.replace(/\/$/, "")}/app`} className="text-sm text-muted underline-offset-4 hover:text-ink hover:underline">
            {t("Ir a Ghosty Studio")}
          </a>
        </footer>
      </div>
    </div>
  );
}

// ── Franja «Tu prueba termina en N días» ─────────────────────────────────────────────

const DISMISS_KEY = "gt_trial_strip_hidden";

/** Franja discreta para el dueño cuando a la prueba le quedan 7 días o menos. Se puede
 *  esconder por un día; vuelve sola al siguiente. */
export function TrialStrip({ isOwner }: { isOwner: boolean }) {
  const status = useSpaceStatus(isOwner);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    try {
      const v = localStorage.getItem(DISMISS_KEY);
      if (v && Date.now() - Number(v) < 86_400_000) setHidden(true);
    } catch {}
  }, []);
  if (!isOwner || !status?.isTrial || status.trialExpired || hidden) return null;
  const n = status.daysLeft ?? daysLeft(status.trialEndsAt);
  if (n === null || n > 7) return null;
  return <TrialStripView status={status} days={n} onHide={() => {
    setHidden(true);
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch {}
  }} />;
}

export function TrialStripView({ status, days, onHide }: { status: SpaceStatus; days: number; onHide?: () => void }) {
  const t = useT();
  const o = activeOffer(status.offer);
  return (
    <div className="flex items-center gap-3 border-b border-[#9A99EA]/30 bg-[#9A99EA]/10 px-4 py-2 md:px-6">
      <Sparkles size={15} className={`shrink-0 ${ACCENT}`} />
      <span className="min-w-0 flex-1 text-sm leading-snug text-ink">
        {o
          ? t("Tu primer mes a mitad de precio si eliges plan antes del {date}", { date: offerDate(o.until, true) })
          : days <= 0
          ? t("Tu prueba termina hoy")
          : days === 1
            ? t("Tu prueba termina mañana")
            : t("Tu prueba termina en {n} días", { n: String(days) })}
      </span>
      <a
        href={status.payUrl}
        className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold transition ${CTA}`}
      >
        {t("Elegir plan")}
      </a>
      {onHide && (
        <button onClick={onHide} aria-label={t("Ocultar")} className="shrink-0 rounded-full p-1 text-muted transition hover:bg-surface-3 hover:text-ink">
          <X size={14} />
        </button>
      )}
    </div>
  );
}

// ── Puerta global ────────────────────────────────────────────────────────────────────

// Rutas que no son del espacio (públicas o sin sesión): ahí no se cierra nada.
const PUBLIC = /^\/(login|join|artefacto\/|coeditar\/|room\/|oauth\/|canvas-demo|canvas-probe|doc-probe|brand-probe|space-probe)/;

/** Tapa el espacio cuando la prueba venció. Va en el layout raíz para cubrir toda ruta
 *  con sesión (rooms, formularios, documentos), no sólo el chat. */
export function SpaceGate() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isPublic = PUBLIC.test(pathname);
  const status = useSpaceStatus(!isPublic);
  const [isOwner, setIsOwner] = useState<boolean | null>(null);
  useEffect(() => {
    if (!status?.trialExpired) return;
    cachedMe()
      .then((u) => setIsOwner(!!u?.isOwner))
      .catch(() => setIsOwner(false));
  }, [status?.trialExpired]);
  if (isPublic || !status?.trialExpired || isOwner === null) return null;
  return <SpaceClosedScreen status={status} isOwner={isOwner} />;
}
