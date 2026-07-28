import { useEffect, useRef, useState } from "react";
import { ChevronDown, MoreHorizontal, ShieldAlert, Globe, Lock, FileText } from "lucide-react";
import { useT } from "../i18n";
import ArtifactShareDialog from "./ArtifactShareDialog";

/**
 * La barra de un artefacto: identidad (título, autor, versión) + compartir.
 *
 * Es UNA sola para los dos lugares donde se ve un artefacto — el panel dentro de
 * Teams y la página pública /a/<slug> — porque la topbar se rompía en anchos
 * angostos y arreglarla en dos sitios significaba arreglarla en uno solo.
 *
 * Se colapsa por ANCHO REAL de la barra (ResizeObserver), no por el viewport: el
 * panel de Teams es redimensionable, así que un breakpoint de pantalla no dice
 * nada sobre el espacio que hay aquí dentro. Compacta: el subtítulo desaparece,
 * "Compartir" se queda en ícono, y las acciones que le pasen se van al menú ⋯.
 */
export type ArtifactShareBarProps = {
  title: string;
  /** "Artefacto de Fulano" — se esconde al compactar. */
  subtitle?: string | null;
  /** Etiqueta de la versión que se está viendo, si es una congelada. */
  versionLabel?: string | null;
  /** documentId; sin él no hay compartir (doc suelto, índice, preview…). */
  documentId?: string | null;
  /** Acciones propias de la superficie (descargar, abrir, cerrar…). */
  actions?: React.ReactNode;
  /** Acciones que SIEMPRE quedan visibles (cerrar, pantalla completa). */
  pinnedActions?: React.ReactNode;
  /** Slot de la izquierda (volver, ícono del agente). */
  leading?: React.ReactNode;
  onReport?: () => void;
};

export default function ArtifactShareBar({
  title,
  subtitle,
  versionLabel,
  documentId,
  actions,
  pinnedActions,
  leading,
  onReport,
}: ArtifactShareBarProps) {
  const t = useT();
  const barRef = useRef<HTMLElement | null>(null);
  const [compact, setCompact] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [isPublic, setIsPublic] = useState(false);

  useEffect(() => {
    const el = barRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setCompact(e.contentRect.width < 520));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // El candado/globo debe ser correcto ANTES de abrir el diálogo — si no, un
  // artefacto ya público se anuncia como privado hasta que alguien lo abra.
  useEffect(() => {
    if (!documentId) return;
    let alive = true;
    (async () => {
      try {
        const { getArtifactShareFn } = await import("../server/artifacts");
        const s = await getArtifactShareFn({ data: { documentId } });
        if (alive && s) setIsPublic(s.visibility === "link");
      } catch {
        /* sin permiso o artefacto viejo → se queda en privado, que es el default seguro */
      }
    })();
    return () => {
      alive = false;
    };
  }, [documentId]);

  // Cerrar el ⋯ al hacer clic fuera o con Escape (si no, se queda pegado al
  // cambiar de artefacto).
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const iconBtn =
    "grid size-7 place-items-center rounded-md text-muted transition hover:bg-surface-3 hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand";

  return (
    <header
      ref={barRef as any}
      className="flex flex-shrink-0 items-center gap-1 border-b border-border bg-surface-2 px-3 py-2"
    >
      {leading ?? <FileText size={16} className="mr-1 shrink-0 text-muted" />}

      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="min-w-0 truncate text-sm font-medium text-ink">{title}</span>
        {versionLabel ? (
          <span className="shrink-0 rounded-full bg-surface-3 px-1.5 py-0.5 text-[11px] font-medium text-muted">
            {versionLabel}
          </span>
        ) : null}
        {subtitle && !compact ? (
          <span className="truncate text-xs text-muted">{subtitle}</span>
        ) : null}
      </div>

      {pinnedActions}

      {/* Al compactar, las acciones secundarias se esconden en ⋯ en vez de
          empujar al título hasta desaparecer. */}
      {actions ? (
        compact ? (
          <div className="relative shrink-0">
            <button
              type="button"
              aria-label={t("Más acciones")}
              aria-expanded={menuOpen}
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((v) => !v);
              }}
              className={iconBtn}
            >
              <MoreHorizontal size={16} />
            </button>
            {menuOpen ? (
              <div
                className="absolute right-0 top-9 z-30 flex min-w-[10rem] flex-col gap-0.5 rounded-lg border border-border bg-surface-2 p-1 shadow-lg"
                onClick={(e) => e.stopPropagation()}
              >
                {actions}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-1">{actions}</div>
        )
      ) : null}

      {/* Reportar. Antes era una banderita: una bandera no dice "reportar" — dice
          "marcar" o "idioma". Escudo con alerta + label explícito. */}
      {onReport ? (
        <button type="button" onClick={onReport} aria-label={t("Reportar artefacto")} title={t("Reportar artefacto")} className={iconBtn}>
          <ShieldAlert size={16} />
        </button>
      ) : null}

      {documentId ? (
        <>
          <button
            type="button"
            onClick={() => setShareOpen(true)}
            aria-label={t("Compartir")}
            title={t("Compartir")}
            className="ml-0.5 inline-flex shrink-0 items-center gap-1.5 rounded-md bg-surface-3 px-2 py-1.5 text-xs font-medium text-ink transition hover:bg-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            {isPublic ? <Globe size={14} /> : <Lock size={14} />}
            {!compact ? t("Compartir") : null}
            {!compact ? <ChevronDown size={13} className="text-muted" /> : null}
          </button>
          {shareOpen ? (
            <ArtifactShareDialog
              documentId={documentId}
              onVisibility={(v) => setIsPublic(v === "link")}
              onClose={() => setShareOpen(false)}
            />
          ) : null}
        </>
      ) : null}
    </header>
  );
}
