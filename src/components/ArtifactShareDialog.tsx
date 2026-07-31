import { useEffect, useState } from "react";
import { Check, ChevronDown, Globe, Link as LinkIcon, Lock, Loader2, X, Info } from "lucide-react";
import type { Invitable } from "../server/doc-invite-suggest";
import type { DocInvite } from "../server/doc-invites";
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
  /** Qué puede hacer quien llega por el link. */
  role: "view" | "comment" | "edit";
  sharedArtifactId: number | null;
  versions: { id: number; label: string; createdAt: number; authors: string[] }[];
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
  /** Cambió el estado de compartir. `sharedArtifactId` = la versión elegida (null = la
   *  más reciente): la página la refleja en su `?v`, que es lo que decide qué se ve. */
  onChange?: (s: { sharedArtifactId: number | null }) => void;
}) {
  const t = useT();
  const [share, setShare] = useState<Share | null>(() => cachedShare(documentId));
  const [loading, setLoading] = useState(() => !cachedShare(documentId));
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  // Invitación nominal por correo (ver la sección "Invitar por correo" más abajo).
  const [correo, setCorreo] = useState("");
  // Gente del workspace, para no teclear de memoria el correo de un compañero. Se pide
  // una vez al abrir; el padrón de un equipo no cambia a media sesión.
  const [gente, setGente] = useState<Invitable[]>([]);
  // Invitaciones vivas de ESTE documento. Sin esto, invitar era un acto de fe: el correo
  // salía y "Quién tiene acceso" seguía enseñando sólo al dueño.
  const [invitaciones, setInvitaciones] = useState<DocInvite[]>([]);
  const [verGente, setVerGente] = useState(false);
  /** Opción marcada por teclado (índice dentro de `filtrada`). */
  const [marcada, setMarcada] = useState(0);
  const [nivelInvitacion, setNivelInvitacion] = useState<"view" | "comment" | "edit">("edit");
  const [invitando, setInvitando] = useState(false);
  const [avisoInvitacion, setAvisoInvitacion] = useState<string | null>(null);
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

  const apply = async (patch: {
    visibility?: "private" | "link";
    sharedArtifactId?: number | null;
    role?: "view" | "comment" | "edit";
  }) => {
    setSaving(true);
    setError(null);
    try {
      const { setArtifactShareFn } = await import("../server/artifacts");
      const s = (await setArtifactShareFn({ data: { documentId, ...patch } })) as Share | null;
      setShare(s);
      putCachedShare(documentId, s);
      if (s) {
        onVisibility?.(s.visibility);
        // La página muestra lo que diga su `?v`: sin avisar, elegir "Versión 2" cambiaba
        // el select y dejaba el documento igual.
        onChange?.({ sharedArtifactId: s.sharedArtifactId });
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
  const writeLink = async (slug: string, role?: "view" | "comment" | "edit") => {
    // El destino depende del NIVEL: con permiso de editar, el enlace lleva a la sala de
    // co-edición; si no, a la página de lectura. Mandar a todos a /artefacto y que ahí
    // hubiera un botón "editar" sería un paso de más para el caso que sí importa.
    const nivel = role ?? share?.role ?? "view";
    const url =
      nivel === "edit"
        ? `${window.location.origin}/coeditar/${slug}`
        : `${window.location.origin}/artefacto/${slug}`;
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
      if (slug) return await writeLink(slug, s?.role);
    }
    if (!slug) return;
    await writeLink(slug);
  };

  const owner = share?.owner;
  const initials = (owner?.name || owner?.email || "?").trim().slice(0, 1).toUpperCase();
  const fmt = (ts: number) =>
    new Date(ts * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  useEffect(() => {
    if (!documentId) return;
    let vivo = true;
    (async () => {
      try {
        const { suggestInviteesFn } = await import("../server/doc-invite-suggest");
        const r = await suggestInviteesFn({ data: { documentId } });
        if (vivo) setGente(r);
        const { listDocInvitesFn } = await import("../server/doc-invites");
        const inv = await listDocInvitesFn({ data: { documentId } });
        if (vivo) setInvitaciones(inv.filter((i) => !i.revoked));
      } catch {
        /* sin padrón se puede invitar igual tecleando el correo */
      }
    })();
    return () => {
      vivo = false;
    };
  }, [documentId]);

  const filtrada = gente.filter((g) => {
    const q = correo.trim().toLowerCase();
    return !q || g.email.includes(q) || g.name.toLowerCase().includes(q);
  });
  const abierta = verGente && filtrada.length > 0;

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
                  <span className="shrink-0 text-xs text-muted">
                    {share.role === "edit" ? t("Puede editar") : share.role === "comment" ? t("Puede comentar") : t("Puede ver")}
                  </span>
                </div>
              ) : null}
              {/* Invitados por correo. `usedAt` distingue "le mandé el correo" de "ya
                  entró": sin esa diferencia no se sabe si hay que reenviarlo. */}
              {invitaciones.map((inv) => (
                <div key={inv.id} className="flex items-center gap-2.5">
                  <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-3 text-[11px] font-semibold text-muted">
                    {(inv.name || inv.email || "?").trim().slice(0, 1).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-ink">{inv.name || inv.email}</p>
                    <p className="truncate text-xs text-muted">
                      {inv.usedAt ? t("Ya entró") : t("Invitación enviada")}
                      {" · "}
                      {inv.role === "edit" ? t("Puede editar") : inv.role === "comment" ? t("Puede comentar") : t("Puede ver")}
                    </p>
                  </div>
                  {share.isOwner ? (
                    <button
                      type="button"
                      title={t("Quitar el acceso")}
                      onClick={async () => {
                        setInvitaciones((prev) => prev.filter((i) => i.id !== inv.id));
                        const { revokeDocInviteFn } = await import("../server/doc-invites");
                        await revokeDocInviteFn({ data: { documentId, inviteId: inv.id } }).catch(() => null);
                      }}
                      className="grid size-7 shrink-0 place-items-center rounded-md text-muted transition hover:bg-surface-3 hover:text-ink"
                    >
                      <X size={14} />
                    </button>
                  ) : null}
                </div>
              ))}
            </section>

            {/* Invitar por CORREO. Es el nivel de identidad que el enlace abierto no
                puede dar: el token va a una dirección concreta, así que quien entra ES
                esa persona y su edición queda atribuible — sin obligarla a crear cuenta.
                Mismo patrón que el visitor sharing de Google y los guests de Figma. */}
            {share.isOwner && documentId ? (
              <section className="flex flex-col gap-2">
                <h3 className="text-xs font-medium text-muted">{t("Invitar por correo")}</h3>
                <div className="flex gap-1.5">
                  {/* Combobox con el patrón ARIA estándar. Dos cosas lo tenían roto:
                      el fondo salía TRANSPARENTE (usaba `bg-surface-1`, un token que no
                      existe — los tokens son surface / surface-2 / surface-3), y con
                      `type="email"` Chrome montaba su propio autocompletado de correos
                      ENCIMA de la lista. */}
                  <div className="relative min-w-0 flex-1">
                    <input
                      // `text` + inputMode, NO `email`: es lo que evita el autofill nativo
                      // de Chrome. El correo se valida en el servidor de todos modos.
                      type="text"
                      inputMode="email"
                      autoComplete="off"
                      name="invitar-a"
                      role="combobox"
                      aria-expanded={abierta}
                      aria-controls="lista-invitables"
                      aria-autocomplete="list"
                      aria-activedescendant={
                        abierta && filtrada[marcada] ? `invitable-${marcada}` : undefined
                      }
                      value={correo}
                      onChange={(e) => {
                        setCorreo(e.target.value);
                        setVerGente(true);
                        setMarcada(0);
                      }}
                      onFocus={() => setVerGente(true)}
                      // Se cierra en el siguiente tick: cerrar en el `blur` inmediato
                      // mata el clic sobre la propia lista.
                      onBlur={() => setTimeout(() => setVerGente(false), 150)}
                      onKeyDown={(e) => {
                        if (!abierta) {
                          if (e.key === "ArrowDown") {
                            setVerGente(true);
                            e.preventDefault();
                          }
                          return;
                        }
                        if (e.key === "ArrowDown") {
                          e.preventDefault();
                          setMarcada((i) => (i + 1) % filtrada.length);
                        } else if (e.key === "ArrowUp") {
                          e.preventDefault();
                          setMarcada((i) => (i - 1 + filtrada.length) % filtrada.length);
                        } else if (e.key === "Enter") {
                          const g = filtrada[marcada];
                          if (g) {
                            e.preventDefault();
                            setCorreo(g.email);
                            setVerGente(false);
                          }
                        } else if (e.key === "Escape") {
                          // Cierra la lista SIN cerrar el diálogo: `stopPropagation` frena
                          // al listener de Escape que cierra Compartir.
                          e.stopPropagation();
                          setVerGente(false);
                        }
                      }}
                      placeholder={t("correo@ejemplo.com")}
                      className="w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus:ring-2 focus:ring-brand/40"
                    />
                    {abierta ? (
                      <ul
                        id="lista-invitables"
                        role="listbox"
                        className="absolute z-[60] mt-1 max-h-56 w-full overflow-auto rounded-lg border border-border bg-surface py-1 shadow-lg"
                      >
                        {filtrada.map((g, i) => (
                          <li key={g.email}>
                            <button
                              type="button"
                              id={`invitable-${i}`}
                              role="option"
                              aria-selected={i === marcada}
                              // `onMouseDown`: el `blur` del input llega antes que el
                              // click y la lista ya no estaría para recibirlo.
                              onMouseDown={(e) => {
                                e.preventDefault();
                                setCorreo(g.email);
                                setVerGente(false);
                              }}
                              onMouseEnter={() => setMarcada(i)}
                              className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-ink transition ${
                                i === marcada ? "bg-surface-3" : ""
                              }`}
                            >
                              {g.avatar ? (
                                <img src={g.avatar} alt="" className="size-6 shrink-0 rounded-full object-cover" referrerPolicy="no-referrer" />
                              ) : (
                                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-surface-3 text-[10px] font-semibold text-muted">
                                  {(g.name[0] ?? "?").toUpperCase()}
                                </span>
                              )}
                              <span className="min-w-0 flex-1">
                                <span className="block truncate">{g.name}</span>
                                <span className="block truncate text-xs text-muted">{g.email}</span>
                              </span>
                              {g.invitado ? (
                                <span className="shrink-0 text-[10px] font-medium uppercase text-muted">{t("Invitado")}</span>
                              ) : null}
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                  <select
                    value={nivelInvitacion}
                    onChange={(e) => setNivelInvitacion(e.target.value as typeof nivelInvitacion)}
                    className="rounded-lg border border-border bg-surface px-2 py-1.5 text-xs text-ink outline-none"
                  >
                    <option value="edit">{t("Editar")}</option>
                    <option value="comment">{t("Comentar")}</option>
                    <option value="view">{t("Ver")}</option>
                  </select>
                  <button
                    type="button"
                    disabled={!correo.trim() || invitando}
                    onClick={async () => {
                      setInvitando(true);
                      setAvisoInvitacion(null);
                      try {
                        const { inviteToDocFn } = await import("../server/doc-invites");
                        const r = await inviteToDocFn({
                          data: { documentId, email: correo, role: nivelInvitacion },
                        });
                        if (!r.ok) setAvisoInvitacion(r.error);
                        else {
                          setCorreo("");
                          // La lista de arriba tiene que reflejarlo YA: es la única señal
                          // de que la invitación existe de verdad.
                          setInvitaciones((prev) => [
                            r.invite,
                            ...prev.filter((i) => i.email !== r.invite.email),
                          ]);
                          // Si el correo no salió (SES apagado), el enlace igual existe:
                          // se ofrece a mano en vez de fingir que se envió.
                          setAvisoInvitacion(
                            r.enviado ? t("Invitación enviada") : `${t("No se pudo enviar el correo. Copia el enlace:")} ${r.url}`
                          );
                        }
                      } catch (e) {
                        setAvisoInvitacion((e as Error).message);
                      } finally {
                        setInvitando(false);
                      }
                    }}
                    className="shrink-0 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-surface transition hover:opacity-90 disabled:opacity-40"
                  >
                    {invitando ? <Loader2 size={14} className="animate-spin" /> : t("Invitar")}
                  </button>
                </div>
                {avisoInvitacion ? (
                  <p className="break-all text-xs text-muted">{avisoInvitacion}</p>
                ) : null}
              </section>
            ) : null}

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
                {/* El chevron NO es adorno: sin él esta fila se lee igual que el <select>
                    de abajo y parece un campo muerto — "¿esto es pura lectura?" fue lo
                    primero que preguntó quien lo usó. */}
                {share.isOwner && !saving ? (
                  <ChevronDown size={14} className="text-muted" />
                ) : null}
              </button>
              <p className="px-0.5 text-xs text-muted">
                {share.visibility === "link"
                  ? t("Cualquiera con el enlace entra sin cuenta, con el nivel de abajo.")
                  : t("Nadie más puede abrirlo. Toca para publicar un enlace.")}
              </p>

              {/* Nivel del enlace. Sólo aparece con el enlace abierto: elegir "puede
                  editar" sobre un documento privado no significa nada y confunde.
                  `edit` manda a quien reciba el link a la sala de co-edición
                  (/coeditar/<slug>), no a la página de lectura. */}
              {share.visibility === "link" ? (
                <div className="flex gap-1 rounded-lg bg-surface-3 p-1">
                  {([
                    ["view", t("Puede ver")],
                    ["comment", t("Puede comentar")],
                    ["edit", t("Puede editar")],
                  ] as const).map(([valor, etiqueta]) => (
                    <button
                      key={valor}
                      type="button"
                      disabled={!share.isOwner || saving}
                      onClick={() => apply({ role: valor })}
                      className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition disabled:cursor-default ${
                        share.role === valor
                          ? "bg-surface text-ink shadow-sm"
                          : "text-muted hover:text-ink disabled:opacity-60"
                      }`}
                    >
                      {etiqueta}
                    </button>
                  ))}
                </div>
              ) : null}
            </section>

            <section className="flex flex-col gap-2">
              <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted">
                {t("Versión compartida")}
                <span title={t("Se comparte esta versión: si editas el artefacto después, quien tenga el enlace seguirá viendo la que elegiste.")}>
                  <Info size={13} />
                </span>
              </h3>
              {/* Siempre editable: el diálogo sólo se abre desde la PÁGINA del
                  artefacto, donde elegir versión sí cambia el documento. La variante
                  de sólo lectura se quitó — venía de cuando esto también vivía en el
                  panel, y ahí enseñaba una versión que no era la que estabas viendo. */}
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
                    {/* Quién co-editó esa sesión. Atribución por SESIÓN: es lo que sí
                        podemos afirmar hoy (el "quién escribió esta línea" llega con
                        Yjs 14). Las versiones del agente no traen autores. */}
                    {v.authors.length ? ` · ${v.authors.join(", ")}` : ""}
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
                  // El rol va explícito: `share` en este closure todavía es el estado
                  // previo y el enlace saldría al destino equivocado.
                  if (s?.slug) await writeLink(s.slug, s.role);
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
