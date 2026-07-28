import { useEffect, useState } from "react";
import { Check, Globe, Link as LinkIcon, Lock, Loader2, X, Info } from "lucide-react";
import { useT } from "../i18n";

// Caché por documento, a nivel de módulo: el estado de compartir sólo cambia desde
// este diálogo, así que reabrirlo no tiene por qué volver a mostrar "Cargando…".
// Se pinta lo cacheado de inmediato y se revalida callado por detrás.
const shareCache = new Map<string, Share>();
export function cachedShare(documentId: string): Share | null {
  return shareCache.get(documentId) ?? null;
}
export function putCachedShare(documentId: string, s: Share | null): void {
  if (s) shareCache.set(documentId, s);
  else shareCache.delete(documentId);
}

export type Share = {
  slug: string | null;
  visibility: "private" | "link";
  sharedArtifactId: number | null;
  versions: { id: number; label: string; createdAt: number }[];
  owner: { sub: string | null; name: string | null; email: string | null; avatar: string | null };
  isOwner: boolean;
};

/**
 * Compartir un artefacto. Tres cosas, en este orden:
 *
 *  1. Copiar enlace — la acción principal, arriba a la derecha.
 *  2. Quién tiene acceso — hoy sólo el dueño; la lista existe porque el siguiente
 *     paso (invitar por correo) cuelga de aquí.
 *  3. Acceso general — sólo yo / cualquiera con el link, con confirmación al abrir.
 *  4. Versión compartida — se comparte una versión CONCRETA, así editar el
 *     artefacto después no cambia lo que la otra persona ya vio.
 */
export default function ArtifactShareDialog({
  documentId,
  onClose,
  onVisibility,
  onChange,
}: {
  documentId: string;
  onClose: () => void;
  onVisibility?: (v: "private" | "link") => void;
  /** Cambió algo que afecta a lo que se sirve (p.ej. la versión compartida). */
  onChange?: () => void;
}) {
  const t = useT();
  const [share, setShare] = useState<Share | null>(() => cachedShare(documentId));
  const [loading, setLoading] = useState(() => !cachedShare(documentId));
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmPublic, setConfirmPublic] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { getArtifactShareFn } = await import("../server/artifacts");
        const s = (await getArtifactShareFn({ data: { documentId } })) as Share | null;
        putCachedShare(documentId, s);
        if (alive) setShare(s);
      } catch (e) {
        if (alive) setError(String((e as Error)?.message ?? e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [documentId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const apply = async (patch: { visibility?: "private" | "link"; sharedArtifactId?: number | null }) => {
    setSaving(true);
    setError(null);
    try {
      const { setArtifactShareFn } = await import("../server/artifacts");
      const s = (await setArtifactShareFn({ data: { documentId, ...patch } })) as Share | null;
      setShare(s);
      putCachedShare(documentId, s);
      if (s) {
        onVisibility?.(s.visibility);
        // La página del artefacto sirve la versión elegida desde su loader: sin
        // avisar, elegir "Versión 2" cambiaba el select y dejaba el documento igual.
        onChange?.();
      }
      return s;
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      return null;
    } finally {
      setSaving(false);
    }
  };

  // Copiar al portapapeles y avisar. Separado de copyLink() porque tras confirmar
  // "compartir públicamente" ya tenemos el slug en la mano y volver a pedirlo sería
  // un viaje de más.
  const writeLink = async (slug: string) => {
    const url = `${window.location.origin}/artefacto/${slug}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2400);
    } catch {
      window.prompt(t("Copia el enlace:"), url);
    }
  };

  // El link se puede copiar aunque siga privado: es el mismo que servirá cuando se
  // abra, y así se puede preparar antes de decidir. Si aún no hay slug, el primer
  // copiado lo acuña.
  const copyLink = async () => {
    let slug = share?.slug;
    if (!slug) {
      const { setArtifactShareFn } = await import("../server/artifacts");
      const s = (await setArtifactShareFn({ data: { documentId } })) as Share | null;
      setShare(s);
      slug = s?.slug ?? null;
    }
    if (!slug) return;
    await writeLink(slug);
  };

  const owner = share?.owner;
  const initials = (owner?.name || owner?.email || "?").trim().slice(0, 1).toUpperCase();
  const fmt = (ts: number) =>
    new Date(ts * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  const row =
    "w-full rounded-lg border border-border bg-surface-3 px-3 py-2.5 text-left text-sm text-ink transition hover:bg-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand";

  return (
    <>
      {/* Capa de cierre: clic fuera cierra. */}
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("Compartir artefacto")}
        className="absolute right-2 top-11 z-50 flex w-[min(26rem,calc(100vw-1rem))] flex-col gap-4 rounded-xl border border-border bg-surface-2 p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-ink">{t("Compartir")}</h2>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={copyLink}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-3 px-2.5 py-1.5 text-xs font-medium text-ink transition hover:bg-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              {copied ? <Check size={14} className="text-brand" /> : <LinkIcon size={14} />}
              {copied ? t("¡Copiado!") : t("Copiar enlace")}
            </button>
            <button type="button" onClick={onClose} aria-label={t("Cerrar")} className="grid size-7 place-items-center rounded-md text-muted transition hover:bg-surface-3 hover:text-ink">
              <X size={16} />
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted">
            <Loader2 size={15} className="animate-spin" /> {t("Cargando…")}
          </div>
        ) : !share ? (
          <p className="py-4 text-sm text-muted">{t("Este artefacto todavía no se puede compartir.")}</p>
        ) : (
          <>
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-muted">{t("Quién tiene acceso")}</h3>
              <div className="flex items-center gap-2.5">
                {owner?.avatar ? (
                  <img src={owner.avatar} alt="" className="size-8 shrink-0 rounded-full object-cover" />
                ) : (
                  <span className="grid size-8 shrink-0 place-items-center rounded-full bg-brand text-xs font-semibold text-surface">
                    {initials}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-ink">
                    {owner?.name || t("Sin nombre")}{" "}
                    {share.isOwner ? <span className="text-muted">({t("tú")})</span> : null}
                  </p>
                  {owner?.email ? <p className="truncate text-xs text-muted">{owner.email}</p> : null}
                </div>
                <span className="shrink-0 text-xs text-muted">{t("Dueño")}</span>
              </div>
              {/* Si está público, la lista se contradecía: enseñaba UNA persona bajo el
                  título "quién tiene acceso" mientras el mundo entero podía entrar. */}
              {share.visibility === "link" ? (
                <div className="flex items-center gap-2.5">
                  <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-3 text-muted">
                    <Globe size={15} />
                  </span>
                  <p className="min-w-0 flex-1 truncate text-sm text-ink">{t("Cualquiera con el enlace")}</p>
                  <span className="shrink-0 text-xs text-muted">{t("Puede ver")}</span>
                </div>
              ) : null}
            </section>

            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-muted">{t("Acceso general")}</h3>
              {/* Sólo el dueño cambia permisos; a los demás se les muestra el estado. */}
              <button
                type="button"
                disabled={!share.isOwner || saving}
                onClick={() =>
                  share.visibility === "link" ? apply({ visibility: "private" }) : setConfirmPublic(true)
                }
                className={`${row} flex items-center gap-2 disabled:cursor-default disabled:opacity-70`}
              >
                {share.visibility === "link" ? <Globe size={15} /> : <Lock size={15} />}
                <span className="flex-1">
                  {share.visibility === "link" ? t("Cualquiera con el enlace") : t("Sólo yo")}
                </span>
                {saving ? <Loader2 size={14} className="animate-spin text-muted" /> : null}
              </button>
            </section>

            <section className="flex flex-col gap-2">
              <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted">
                {t("Versión compartida")}
                <span title={t("Se comparte esta versión: si editas el artefacto después, quien tenga el enlace seguirá viendo la que elegiste.")}>
                  <Info size={13} />
                </span>
              </h3>
              <select
                disabled={!share.isOwner || saving}
                value={share.sharedArtifactId ?? ""}
                onChange={(e) => apply({ sharedArtifactId: e.target.value ? Number(e.target.value) : null })}
                className={`${row} disabled:cursor-default disabled:opacity-70`}
              >
                <option value="">{t("La más reciente")}</option>
                {share.versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label} · {fmt(v.createdAt)}
                  </option>
                ))}
              </select>
            </section>
          </>
        )}

        {error ? <p className="text-xs text-red-500">{error}</p> : null}
      </div>

      {/* Hacerlo público es la acción irreversible del diálogo (el link puede haberse
          reenviado ya), así que se confirma con lo que implica escrito. */}
      {/* Se ancla DEBAJO del propio panel de compartir, no en el centro de la
          pantalla: la decisión es sobre lo que estás mirando aquí, y mandar la
          mirada a la esquina opuesta para confirmar es un salto gratis. */}
      {confirmPublic ? (
        <div className="absolute right-2 top-11 z-[60] w-[min(26rem,calc(100vw-1rem))]" onClick={(e) => e.stopPropagation()}>
          <div
            role="alertdialog"
            aria-modal="true"
            className="flex flex-col gap-3 rounded-xl border border-border bg-surface-2 p-5 shadow-2xl"
          >
            <h2 className="text-lg font-semibold text-ink">{t("¿Compartir con cualquiera que tenga el enlace?")}</h2>
            <p className="text-sm text-muted">
              {t("Cualquier persona con este enlace podrá ver el artefacto, aunque no tenga cuenta ni sesión iniciada. Esto incluye a gente fuera de tu equipo.")}
            </p>
            <div className="mt-1 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmPublic(false)}
                className="rounded-lg border border-border px-3 py-1.5 text-sm text-ink transition hover:bg-surface-3"
              >
                {t("Cancelar")}
              </button>
              <button
                type="button"
                onClick={async () => {
                  setConfirmPublic(false);
                  // Abrirlo y COPIARLO en un paso: quien confirma esto es porque va a
                  // pegar el link ahora. Antes había que volver a "Copiar enlace" y el
                  // botón no daba ninguna señal de que algo hubiera pasado.
                  const s = await apply({ visibility: "link" });
                  if (s?.slug) await writeLink(s.slug);
                }}
                className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-surface transition hover:opacity-90"
              >
                {t("Compartir públicamente")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
