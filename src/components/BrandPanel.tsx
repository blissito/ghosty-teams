import { useEffect, useRef, useState } from "react";
import { Check, ImagePlus, Loader2, Pencil, Plus, Trash2, Wand2 } from "lucide-react";
import {
  BRAND_MOODS,
  type BrandColors,
  type BrandKit,
  brandFormVars,
  brandFontStacks,
  brandPalette,
  brandRadiusScale,
  brandShape,
  brandThemeCss,
  isHex,
} from "../lib/brand-tokens";
import {
  activateBrandKitFn,
  deleteBrandKitFn,
  extractBrandFromLogoFn,
  extractBrandFromUrlFn,
  listBrandKitsFn,
  saveBrandKitFn,
} from "../server/brand";
import ConfirmModal from "./ConfirmModal";
import { reloadBrandPalette } from "../utils/theme";
import { BRAND_FONTS } from "../lib/brand-fonts";
import { useT } from "../i18n";

// ── Ajustes → Marca ─────────────────────────────────────────────────────────
// Varios kits, uno activo. Vive en Ajustes y no en el sidebar porque una marca se toca
// dos veces al año y después se consume sola: el sidebar es para contenido que se visita.
//
// El preview NO es adorno. Es lo que hace que esto se entienda sin explicarlo: los mismos
// derivadores que hornean el formulario y el PDF (`brand-tokens`, isomorfo) pintan aquí,
// así que lo que se ve es literalmente lo que se va a publicar.

type Kit = BrandKit & { isActive: boolean; logoKey: string | null; logoDarkKey: string | null };

const BLANK: BrandColors = {
  primary: "#7c3aed",
  secondary: "#a78bfa",
  accent: "#f59e0b",
  surface: "#ffffff",
};

export function BrandPanel({ isOwner }: { isOwner: boolean }) {
  const t = useT();
  const [kits, setKits] = useState<Kit[] | null>(null);
  const [editing, setEditing] = useState<Kit | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const [borrando, setBorrando] = useState<Kit | null>(null);

  async function reload() {
    setKits((await listBrandKitsFn()) as Kit[]);
  }

  /**
   * La app entera se pinta con `/api/brand-css`, una hoja que el navegador cargó UNA vez
   * al abrir la pestaña. Cambiar el kit activo escribe en la DB y refresca esta lista,
   * pero el `<link>` sigue sirviendo la marca anterior: se veía como que activar un kit
   * no hacía nada, y la única forma de enterarse era recargar a mano. Se vuelve a pedir
   * con un parámetro distinto (la hoja se sirve con `max-age=30`, así que sin él el
   * navegador contestaría con la copia vieja).
   */
  function refreshBrandSheet() {
    const link = document.querySelector<HTMLLinkElement>('link[rel="stylesheet"][href^="/api/brand-css"]');
    if (link) link.href = `/api/brand-css?r=${Date.now()}`;
    // La muestra del selector de temas lee la misma hoja (ver utils/theme.ts).
    reloadBrandPalette();
  }
  useEffect(() => {
    reload().catch(() => setKits([]));
  }, []);

  async function activate(id: string) {
    setBusy(true);
    try {
      await activateBrandKitFn({ data: { id } });
      await reload();
      refreshBrandSheet();
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await deleteBrandKitFn({ data: { id } });
      await reload();
      refreshBrandSheet();
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <KitEditor
        kit={editing === "new" ? null : editing}
        onCancel={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          await reload();
          refreshBrandSheet();
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {/* Sin h3 "Marca": el modal de Ajustes ya pinta ese título justo encima. */}
          <p className="text-xs text-muted">
            {t("Los colores, las fuentes y el logo con los que salen tus documentos, formularios y ligas compartidas.")}
          </p>
        </div>
        {isOwner && (
          <button
            onClick={() => setEditing("new")}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-brand-fg"
          >
            <Plus className="h-3.5 w-3.5" /> {t("Nueva marca")}
          </button>
        )}
      </div>

      {kits === null && <p className="text-xs text-muted">{t("Cargando…")}</p>}

      {kits?.length === 0 && (
        <div className="rounded-xl border border-dashed border-border p-6 text-center">
          <p className="text-sm">{t("Todavía no hay ninguna marca.")}</p>
          <p className="mt-1 text-xs text-muted">
            {t("Puedes sacarla de tu página web o de tu logo, y el agente también puede hacerlo por ti.")}
          </p>
        </div>
      )}

      <div className="space-y-2">
        {kits?.map((k) => (
          <div key={k.id} className="flex items-center gap-3 rounded-xl border border-border p-3">
            <KitSwatch kit={k} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold">{k.name}</span>
                {k.isActive && (
                  <span className="shrink-0 rounded-full bg-brand/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand">
                    {t("Activa")}
                  </span>
                )}
              </div>
              <p className="mt-0.5 truncate text-xs text-muted">
                {fontLabel(k) || t("Fuentes del sistema")}
              </p>
            </div>
            {isOwner && (
              <div className="flex shrink-0 items-center gap-1">
                {!k.isActive && (
                  <button
                    disabled={busy}
                    onClick={() => activate(k.id)}
                    className="rounded-lg px-2.5 py-1.5 text-xs font-semibold hover:bg-surface-3"
                  >
                    {t("Usar")}
                  </button>
                )}
                {/* Icono, no texto: hace pareja con la papelera de al lado y deja de
                    competir con "Usar", que es la acción que sí quiere una palabra. */}
                <button
                  onClick={() => setEditing(k)}
                  aria-label={t("Editar")}
                  title={t("Editar")}
                  className="rounded-lg p-1.5 text-muted hover:bg-surface-3 hover:text-ink"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                {/* Borrar una marca no tiene deshacer: pasa por confirmación, como el
                    resto de lo destructivo del producto. */}
                <button
                  disabled={busy}
                  onClick={() => setBorrando(k)}
                  aria-label={t("Eliminar")}
                  title={t("Eliminar")}
                  className="rounded-lg p-1.5 text-muted hover:bg-surface-3 hover:text-red-500"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {borrando && (
        <ConfirmModal
          title={t("¿Eliminar esta marca?")}
          // Se dice QUÉ pasa después, no sólo que es irreversible: si era la activa, el
          // espacio se queda con otra (o sin ninguna) y eso cambia lo que se publique.
          body={
            borrando.isActive
              ? t("Se elimina «{n}», que es la marca activa. Lo que publiques después saldrá con otra marca, o sin ninguna si no queda alguna. Lo ya publicado no cambia.").replace("{n}", borrando.name)
              : t("Se elimina «{n}». No se puede deshacer; lo ya publicado con ella no cambia.").replace("{n}", borrando.name)
          }
          confirmLabel={t("Eliminar")}
          danger
          onCancel={() => setBorrando(null)}
          onConfirm={async () => {
            await remove(borrando.id);
            setBorrando(null);
          }}
        />
      )}
    </div>
  );
}

// Los nombres van en español y pasan por t(): el modelo recibe la LLAVE (professional,
// bold…), la persona lee una palabra.
// Cortos a propósito: en una rejilla de 4 columnas cualquier palabra larga se corta con
// puntos suspensivos, y un tono que no puedes leer no lo puedes elegir.
const MOOD_LABEL: Record<string, string> = {
  professional: "Sobrio",
  minimal: "Mínimo",
  elegant: "Elegante",
  warm: "Cálido",
  bold: "Fuerte",
  vibrant: "Vibrante",
  playful: "Alegre",
};

/**
 * Elegir fuente: catálogo con MUESTRA, o subir la propia.
 *
 * ⚠️ Sustituyó a un campo de texto libre donde escribías "Playfair Display" y no pasaba
 * nada: se guardaba el nombre y NADIE cargaba el archivo, así que el navegador pedía una
 * familia que el visitante no tiene y caía al respaldo en silencio. Del catálogo servimos
 * el woff2 nosotros; la subida sube el archivo de verdad.
 *
 * Cada opción se pinta EN su propia fuente. Es lo mismo que hacen los tonos: una
 * tipografía tampoco se puede elegir a ciegas.
 */
function FontPicker({
  label,
  value,
  customUrl,
  customName,
  onPick,
  onUpload,
  onClearCustom,
}: {
  label: string;
  value: string;
  customUrl: string;
  customName: string;
  onPick: (id: string) => void;
  onUpload: (url: string, name: string) => void;
  onClearCustom: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ref = useRef<HTMLInputElement>(null);

  async function subir(file: File) {
    setBusy(true);
    setError("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("kind", "font");
      const res = await fetch("/api/brand-logo", { method: "POST", body: fd });
      if (!res.ok) throw new Error(await res.text());
      const out = (await res.json()) as { url: string };
      onUpload(out.url, file.name.replace(/\.woff2$/i, ""));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <label className="text-xs font-semibold">{label}</label>
      {customUrl ? (
        <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-border px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-xs">{customName || t("Fuente propia")}</span>
          <button onClick={onClearCustom} className="text-xs text-muted hover:text-ink">
            {t("Quitar")}
          </button>
        </div>
      ) : (
        <div className="mt-1.5 grid grid-cols-3 gap-1.5">
          <button
            type="button"
            onClick={() => onPick("")}
            aria-pressed={!value}
            className={`rounded-lg border px-2 py-1.5 text-left text-[11px] ${
              !value ? "border-brand font-semibold" : "border-border text-muted"
            }`}
          >
            {t("Del sistema")}
          </button>
          {BRAND_FONTS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => onPick(f.id)}
              aria-pressed={value === f.id}
              title={f.family}
              className={`truncate rounded-lg border px-2 py-1.5 text-left text-[11px] ${
                value === f.id ? "border-brand font-semibold" : "border-border"
              }`}
              // La muestra en su propia familia: el `@font-face` lo sirve /api/brand-css
              // cuando el kit está activo, y en el panel el navegador la pide a /fonts/.
              style={{ fontFamily: `"${f.family}", ${f.kind}` }}
            >
              {f.family}
            </button>
          ))}
        </div>
      )}
      <div className="mt-1 flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => ref.current?.click()}
          className="text-xs text-muted underline hover:text-ink disabled:opacity-50"
        >
          {busy ? t("Subiendo…") : t("o sube tu .woff2")}
        </button>
        {error && <span className="text-xs text-red-500">{error}</span>}
      </div>
      <input
        ref={ref}
        type="file"
        accept=".woff2,font/woff2"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) subir(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/**
 * Cada tono, pintado con los tokens que ese tono produce: fondo teñido, línea, un botón
 * y la "Aa" en la familia que le toca. Es la única forma de elegir tono sin adivinar.
 */
function MoodSwatch({
  mood,
  colors,
  label,
  selected,
  onPick,
}: {
  mood: string;
  colors: BrandColors;
  label: string;
  selected: boolean;
  onPick: () => void;
}) {
  const k: BrandKit = { id: "m", name: "m", colors, mood: mood as BrandKit["mood"] };
  const p = brandPalette(k).light;
  const s = brandShape(k);
  const scale = brandRadiusScale(k);
  // ⚠️ Sin clamp propio. El anterior era `Math.min(radius, 14)` y colapsaba warm, vibrant
  // y playful al MISMO valor —tres de siete muestras idénticas— y encima no coincidía con
  // el clamp del horneado. La muestra pinta el escalón `xl`, que es el de una tarjeta:
  // exactamente lo que se va a ver.
  const r = scale.xl;
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={selected}
      title={label}
      className={`p-1 text-left transition ${selected ? "" : "opacity-70 hover:opacity-100"}`}
    >
      <div
        className="flex h-12 flex-col justify-between p-1.5"
        style={{
          background: p["surface-2"],
          border: `${s.edge}px solid ${selected ? p.brand : p.border}`,
          borderRadius: `${r}px`,
          boxShadow: s.shadow === 0 ? "none" : s.shadow === 2 ? `2px 2px 0 ${p.brand}` : "0 2px 6px rgba(0,0,0,.10)",
        }}
      >
        <span
          className="text-[10px] leading-none"
          style={{
            color: p.ink,
            fontFamily: s.serif ? "Georgia, serif" : "inherit",
            fontWeight: s.caps ? 700 : 600,
            textTransform: s.caps ? "uppercase" : "none",
            letterSpacing: s.caps ? ".08em" : 0,
          }}
        >
          Aa
        </span>
        <span
          className="h-2 w-full"
          style={{ background: p.brand, borderRadius: `${scale.sm}px` }}
        />
      </div>
      <span
        className={`mt-1 block truncate text-[10px] ${selected ? "font-semibold text-ink" : "text-muted"}`}
      >
        {label}
      </span>
    </button>
  );
}

/** Lo que se lee bajo el nombre del kit: familias de verdad, no ids. */
function fontLabel(k: BrandKit): string {
  const nombre = (slot: "heading" | "body") =>
    (slot === "heading" ? k.fonts?.headingName : k.fonts?.bodyName) ||
    BRAND_FONTS.find((f) => f.id === (slot === "heading" ? k.fonts?.heading : k.fonts?.body))?.family;
  return [...new Set([nombre("heading"), nombre("body")].filter(Boolean))].join(" · ");
}

/**
 * La miniatura de la lista. Si el kit tiene LOGO, manda el logo: es lo que identifica
 * una marca de un vistazo. Los puntos de color son el respaldo para cuando no lo hay.
 */
function KitSwatch({ kit }: { kit: BrandKit }) {
  const p = brandPalette(kit).light;
  const [roto, setRoto] = useState(false);
  const conLogo = !!kit.logoUrl && !roto;
  return (
    <div
      className="flex h-11 w-11 shrink-0 flex-col justify-end gap-1 overflow-hidden rounded-lg border border-black/10 p-1.5"
      style={
        conLogo
          ? {
              // Misma cuadrícula que el editor: un logo blanco sobre transparente es
              // invisible en una caja clara y parece que no cargó.
              backgroundImage:
                "linear-gradient(45deg,#0000000d 25%,transparent 25%,transparent 75%,#0000000d 75%)," +
                "linear-gradient(45deg,#0000000d 25%,transparent 25%,transparent 75%,#0000000d 75%)",
              backgroundSize: "10px 10px",
              backgroundPosition: "0 0,5px 5px",
            }
          : { background: p.surface }
      }
    >
      {conLogo ? (
        <img
          src={kit.logoUrl as string}
          alt=""
          onError={() => setRoto(true)}
          className="m-auto max-h-full max-w-full object-contain"
        />
      ) : (
        <div className="flex gap-1">
          <span className="h-2 w-2 rounded-full" style={{ background: p.brand }} />
          <span className="h-2 w-2 rounded-full" style={{ background: p["brand-2"] }} />
        </div>
      )}
    </div>
  );
}

// ── Editor ──────────────────────────────────────────────────────────────────

type SectionId = "basicos" | "color" | "letra" | "tono" | "origen";

// Cuatro pasos cortos en vez de una columna de 1200px. El orden es el de una marca real:
// cómo se llama y su logo → sus colores → su letra → su carácter.
const SECTIONS: { id: SectionId; label: string }[] = [
  { id: "basicos", label: "Básicos" },
  { id: "color", label: "Color" },
  { id: "letra", label: "Letra" },
  { id: "tono", label: "Tono" },
  { id: "origen", label: "Importar" },
];

const FIELDS: { key: keyof BrandColors; label: string }[] = [
  { key: "primary", label: "Principal" },
  { key: "secondary", label: "Secundario" },
  { key: "accent", label: "Acento" },
  { key: "surface", label: "Fondo" },
];

function KitEditor({
  kit,
  onCancel,
  onSaved,
}: {
  kit: Kit | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(kit?.name ?? "");
  const [colors, setColors] = useState<BrandColors>(kit?.colors ?? BLANK);
  const [heading, setHeading] = useState(kit?.fonts?.heading ?? "");
  const [body, setBody] = useState(kit?.fonts?.body ?? "");
  const [headingUrl, setHeadingUrl] = useState(kit?.fonts?.headingUrl ?? "");
  const [bodyUrl, setBodyUrl] = useState(kit?.fonts?.bodyUrl ?? "");
  const [headingName, setHeadingName] = useState(kit?.fonts?.headingName ?? "");
  const [bodyName, setBodyName] = useState(kit?.fonts?.bodyName ?? "");
  const [logoUrl, setLogoUrl] = useState(kit?.logoUrl ?? "");
  const [logoKey, setLogoKey] = useState(kit?.logoKey ?? "");
  const [mood, setMood] = useState(kit?.mood ?? "");
  const [url, setUrl] = useState("");
  const [section, setSection] = useState<SectionId>("basicos");
  const [busy, setBusy] = useState<null | "save" | "url" | "logo">(null);
  const [dragging, setDragging] = useState(false);
  const [logoError, setLogoError] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // El preview usa el mismo derivador que el servidor, así que no puede mentir.
  const preview: BrandKit = {
    id: "preview",
    name: name || t("Marca"),
    colors,
    fonts: {
      heading: heading || undefined,
      body: body || undefined,
      headingUrl: headingUrl || undefined,
      bodyUrl: bodyUrl || undefined,
      headingName: headingName || undefined,
      bodyName: bodyName || undefined,
    },
    logoUrl: logoUrl || null,
    // El tono mueve la derivación, así que el preview grande lo necesita o enseñaría
    // otra cosa distinta a la que se guarda.
    mood: (mood || null) as BrandKit["mood"],
  };
  const valid = FIELDS.every((f) => isHex(colors[f.key] as string)) && name.trim().length > 0;

  async function uploadLogo(file: File) {
    setBusy("logo");
    setError("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/brand-logo", { method: "POST", body: fd });
      if (!res.ok) throw new Error(await res.text());
      const out = (await res.json()) as { key: string; url: string };
      setLogoKey(out.key);
      setLogoUrl(out.url);
      setLogoError(false);
      // Un logo recién subido casi siempre trae la paleta que la persona quiere; se
      // ofrece, no se impone: sólo rellena si todavía está en los valores de fábrica.
      if (colors.primary === BLANK.primary && colors.secondary === BLANK.secondary) {
        const guess = await extractBrandFromLogoFn({ data: { key: out.key } }).catch(() => null);
        if (guess) setColors(guess);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function fromUrl() {
    if (!url.trim()) return;
    setBusy("url");
    setError("");
    try {
      const out = await extractBrandFromUrlFn({ data: { url: url.trim() } });
      setColors(out.colors);
      if (out.logoKey) {
        setLogoKey(out.logoKey);
        setLogoUrl(out.logoUrl || "");
      }
      if (!name.trim() && out.name) setName(out.name);
      if (!out.logoKey) setError(t("No encontré el logo; súbelo tú y revisa los colores."));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setBusy("save");
    setError("");
    try {
      await saveBrandKitFn({
        data: {
          id: kit?.id,
          name: name.trim(),
          colors,
          fonts:
            heading || body || headingUrl || bodyUrl
              ? {
                  heading: heading || undefined,
                  body: body || undefined,
                  headingUrl: headingUrl || undefined,
                  bodyUrl: bodyUrl || undefined,
                  headingName: headingName || undefined,
                  bodyName: bodyName || undefined,
                }
              : null,
          logoKey: logoKey || null,
          mood: mood || null,
        },
      });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }

  // ⚠️ Tres franjas: cabecera fija, CUERPO que scrollea por dentro y footer anclado. Antes
  // era una sola columna larguísima dentro del modal (h-[85dvh]) y el resultado era que
  // había que scrollear para llegar al Tono y el botón Guardar salía CORTADO por abajo.
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ⚠️ SIN cabecera propia: el modal de Ajustes ya pinta su título y su ✕, y esto
          añadía un segundo par justo debajo. La identidad del editor la lleva el botón
          Cancelar del footer, que además dice lo que hace. */}

      {/* Secciones: el editor entero no cabe de una vez, y paginarlo en cuatro pasos
          cortos es lo que evita el scroll infinito. El preview NO entra aquí: se queda
          fijo al lado, porque es lo que hay que estar mirando mientras se toca cualquiera
          de las cuatro. */}
      <div className="flex shrink-0 gap-1 border-b border-border pb-2">
        {SECTIONS.map((sec) => (
          <button
            key={sec.id}
            onClick={() => setSection(sec.id)}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              section === sec.id ? "bg-brand/10 text-brand" : "text-muted hover:bg-surface-3"
            }`}
          >
            {t(sec.label)}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 gap-4 pt-3">
        <div className="min-w-0 flex-1 overflow-y-auto pr-1">
      {section === "origen" && (
      <div className="rounded-xl border border-border p-3">
        <label className="text-xs font-semibold">{t("Sácala de una página web")}</label>
        <div className="mt-2 flex gap-2">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
            className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm"
          />
          <button
            disabled={busy !== null || !url.trim()}
            onClick={fromUrl}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-surface-3 px-3 py-2 text-xs font-semibold disabled:opacity-50"
          >
            {busy === "url" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
            {t("Extraer")}
          </button>
        </div>
        <p className="mt-1.5 text-xs text-muted">
          {t("Leemos los colores y el logo de la página. Revísalos antes de guardar.")}
        </p>
      </div>

      )}

      {section === "basicos" && (
        <div className="space-y-4">
          <div>
            <label className="text-xs font-semibold">{t("Nombre")}</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="text-xs font-semibold">{t("Logo")}</label>
            {/* La caja ES el control: click o arrastrar. Antes había recuadro + botón
                "Subir" para una sola acción, y el recuadro no hacía nada — dos cosas
                donde basta una. */}
            <div className="mt-1 flex items-start gap-2">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  const f = e.dataTransfer.files?.[0];
                  if (f) uploadLogo(f);
                }}
                aria-label={t("Subir logo")}
                className={`flex h-20 w-40 flex-col items-center justify-center gap-1 rounded-xl border border-dashed p-2 text-center transition disabled:opacity-50 ${
                  dragging ? "border-brand bg-brand/5" : "border-border hover:border-brand/50"
                }`}
                // Cuadrícula de fondo: un logo BLANCO sobre transparente es invisible
                // encima de una superficie clara, y se lee como "no cargó".
                style={
                  logoUrl && !logoError
                    ? {
                        backgroundImage:
                          "linear-gradient(45deg,#0000000d 25%,transparent 25%,transparent 75%,#0000000d 75%)," +
                          "linear-gradient(45deg,#0000000d 25%,transparent 25%,transparent 75%,#0000000d 75%)",
                        backgroundSize: "12px 12px",
                        backgroundPosition: "0 0,6px 6px",
                      }
                    : undefined
                }
              >
                {busy === "logo" ? (
                  <Loader2 className="h-4 w-4 animate-spin text-muted" />
                ) : logoUrl ? (
                  logoError ? (
                    // ⚠️ NUNCA una caja vacía. Un `<img>` que falla no se ve, y desde
                    // fuera eso es idéntico a "no subí nada": es el mismo fallo mudo que
                    // arrastró esta feature. Si no carga, se dice y se enseña de dónde.
                    <span className="px-1 text-[10px] leading-tight text-red-500">
                      {t("No pude cargar la imagen")}
                      <br />
                      <span className="text-muted">{logoUrl.replace(/^https?:\/\//, "").slice(0, 34)}…</span>
                    </span>
                  ) : (
                    <img
                      src={logoUrl}
                      alt=""
                      onError={() => setLogoError(true)}
                      onLoad={() => setLogoError(false)}
                      className="max-h-full max-w-full object-contain"
                    />
                  )
                ) : (
                  <>
                    <ImagePlus className="h-4 w-4 text-muted" />
                    <span className="text-[11px] leading-tight text-muted">
                      {t("Arrastra tu logo o haz clic")}
                    </span>
                  </>
                )}
              </button>
              {logoUrl && (
                <button
                  onClick={() => {
                    setLogoUrl("");
                    setLogoKey("");
                  }}
                  aria-label={t("Quitar")}
                  className="rounded-lg p-1.5 text-muted hover:bg-surface-3 hover:text-ink"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadLogo(f);
                e.target.value = "";
              }}
            />
          </div>

        </div>
      )}

      {section === "color" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            {FIELDS.map((f) => (
              <div key={f.key}>
                <label className="text-xs font-semibold">{t(f.label)}</label>
                <div className="mt-1 flex items-center gap-2 rounded-lg border border-border px-2 py-1.5">
                  <input
                    type="color"
                    value={isHex(colors[f.key] as string) ? (colors[f.key] as string) : "#000000"}
                    onChange={(e) => setColors({ ...colors, [f.key]: e.target.value })}
                    aria-label={t(f.label)}
                    className="h-6 w-6 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
                  />
                  <input
                    value={colors[f.key] as string}
                    onChange={(e) => setColors({ ...colors, [f.key]: e.target.value })}
                    className={`min-w-0 flex-1 bg-transparent text-xs outline-none ${
                      isHex(colors[f.key] as string) ? "" : "text-red-500"
                    }`}
                  />
                </div>
              </div>
            ))}
          </div>

        </div>
      )}

      {section === "letra" && (
        <div className="space-y-4">
            <FontPicker
              label={t("Fuente de títulos")}
              value={heading}
              customUrl={headingUrl}
              customName={headingName}
              onPick={(id) => { setHeading(id); setHeadingUrl(""); }}
              onUpload={(url, name) => { setHeadingUrl(url); setHeadingName(name); }}
              onClearCustom={() => { setHeadingUrl(""); setHeadingName(""); }}
            />
            <FontPicker
              label={t("Fuente de texto")}
              value={body}
              customUrl={bodyUrl}
              customName={bodyName}
              onPick={(id) => { setBody(id); setBodyUrl(""); }}
              onUpload={(url, name) => { setBodyUrl(url); setBodyName(name); }}
              onClearCustom={() => { setBodyUrl(""); setBodyName(""); }}
            />
        </div>
      )}

      {section === "tono" && (
          <div>
            {/* Muestras y no un <select>: el tono MUEVE la derivación (cuánto tiñe la
                marca, qué tan marcada es la línea, si los títulos caen en serif), así que
                tiene que poder compararse de un vistazo — igual que las fuentes. */}
            {/* Sin chip "Neutro": no elegir tono se comporta EXACTAMENTE como "Sobrio",
                así que eran dos casillas para un solo estado. Sobrio queda seleccionado
                por defecto y guardarlo lo hace explícito. */}
            <div className="mt-1.5 grid grid-cols-4 gap-1.5">
              {BRAND_MOODS.map((m) => (
                <MoodSwatch
                  key={m}
                  mood={m}
                  colors={colors}
                  label={t(MOOD_LABEL[m])}
                  selected={mood === m || (!mood && m === "professional")}
                  onPick={() => setMood(m)}
                />
              ))}
            </div>
            <p className="mt-1.5 text-xs text-muted">
              {t("Ajusta el teñido, el trazo y la tipografía. También se lo pasamos al agente cuando diseña para ti.")}
            </p>
          </div>
      )}
        </div>

        {/* El preview NO scrollea con los controles: se queda fijo al lado. Antes vivía
            dentro de la columna larga y desaparecía justo cuando tocabas el tono, que es
            cuando más falta hace mirarlo. */}
        <div className="hidden w-56 shrink-0 overflow-y-auto md:block">
          <BrandPreview kit={preview} />
        </div>
      </div>

      {/* Footer ANCLADO. Estaba al final de la columna larga y el modal lo cortaba: el
          botón Guardar quedaba a medias fuera de la vista. */}
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border pt-3">
        {error && <p className="mr-auto text-xs text-red-500">{error}</p>}
        <button onClick={onCancel} className="rounded-lg px-3 py-2 text-xs font-semibold hover:bg-surface-3">
          {t("Cancelar")}
        </button>
        <button
          disabled={!valid || busy !== null}
          onClick={save}
          className="flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-xs font-semibold text-brand-fg disabled:opacity-50"
        >
          {busy === "save" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          {t("Guardar")}
        </button>
      </div>
    </div>
  );
}

/**
 * Las tres salidas, con los MISMOS tokens que hornea el servidor. Es una maqueta chica a
 * propósito: lo que hay que poder juzgar de un vistazo es si el texto se lee y si el logo
 * pega con los colores, no el layout.
 */
function BrandPreview({ kit }: { kit: BrandKit }) {
  const t = useT();
  const form = brandFormVars(kit);
  const p = brandPalette(kit);
  // ⚠️ NADA de `rounded-*` ni `border` de Tailwind aquí. Este preview tenía las clases
  // fijas y por eso enseñaba sólo el color: cambiabas el tono y no se movía una esquina.
  // Todo sale de los mismos tokens que hornea el servidor.
  const r = brandRadiusScale(kit);
  const s = brandShape(kit);
  const f = brandFontStacks(kit);
  const caps = s.caps ? ({ textTransform: "uppercase", letterSpacing: ".08em" } as const) : {};
  // Los cinco de la serie salen del mismo `@theme` que se hornea en un artefacto.
  const theme = brandThemeCss(kit);
  const chartStrip = [1, 2, 3, 4, 5].map(
    (i) => theme.match(new RegExp(`--color-chart-${i}: (#[0-9a-f]{6})`))?.[1] ?? "#ccc"
  );

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-muted">{t("Así se va a ver")}</p>

      {/* Formulario público */}
      <div
        className="p-3"
        style={{
          background: form["--paper"],
          border: `${form["--edge"]} solid ${form["--line"]}`,
          borderRadius: form["--radius-xl"],
          boxShadow: form["--shadow"],
        }}
      >
        {kit.logoUrl && <img src={kit.logoUrl} alt="" className="mb-2 max-h-6 max-w-[50%] object-contain" />}
        <p className="text-sm font-semibold" style={{ color: form["--ink"], fontFamily: f.heading }}>
          {t("Formulario")}
        </p>
        <p className="mt-0.5 text-[11px]" style={{ color: form["--muted"], fontFamily: f.body }}>
          {t("Cuéntanos de tu caso")}
        </p>
        <div className="mt-2 h-1 rounded-full" style={{ background: form["--tint"] }}>
          <div className="h-1 w-1/3 rounded-full" style={{ background: form["--accent"] }} />
        </div>
        {/* Los CUATRO colores de entrada visibles, más las señales. Antes el preview sólo
            pintaba el principal y por eso parecía que los otros tres no hacían nada — y
            en buena medida era cierto. */}
        <p className="mt-2 text-[10px] font-semibold" style={{ color: form["--sec"], letterSpacing: ".06em" }}>
          {t("SECCIÓN")}
        </p>
        <p className="mt-0.5 text-[10px]" style={{ color: form["--ink"] }}>
          {t("Obligatorio")}
          <span style={{ color: form["--req"] }}> *</span>
        </p>
        <span
          className="mt-2 inline-block px-2.5 py-1 text-[11px] font-semibold"
          style={{
            background: form["--accent"],
            color: p.light["brand-fg"],
            borderRadius: form["--radius-md"],
            ...caps,
          }}
        >
          {t("Enviar")}
        </span>
      </div>

      {/* La serie de gráficas: es donde el secundario y el acento hacen trabajo de verdad. */}
      <div className="flex items-center gap-1">
        {[0, 1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className="h-3 flex-1"
            style={{ background: chartStrip[i], borderRadius: r.xs + "px" }}
          />
        ))}
        <span className="ml-1 shrink-0 text-[9px] text-muted">{t("gráficas")}</span>
      </div>

      {/* Documento en papel */}
      <div
        className="bg-white p-3"
        style={{
          border: `${form["--edge"]} solid ${p.light.border}`,
          borderRadius: r.xl + "px",
        }}
      >
        {kit.logoUrl && (
          <img
            src={kit.logoUrl}
            alt=""
            className="mb-1.5 max-h-5 max-w-[40%] object-contain pb-1.5"
            style={{ borderBottom: `calc(${form["--edge"]} * 2) solid ${p.light.brand}` }}
          />
        )}
        <p className="text-[11px] font-bold" style={{ color: p.light.ink, fontFamily: f.heading, ...caps }}>
          {t("Documento")}
        </p>
        <div className="mt-1 space-y-1">
          <div className="h-1 w-full" style={{ background: p.light.border, borderRadius: r.xs + "px" }} />
          <div className="h-1 w-4/5" style={{ background: p.light.border, borderRadius: r.xs + "px" }} />
        </div>
      </div>

      {/* La app, en oscuro: es donde se nota si la marca aguanta el modo noche. */}
      <div
        className="p-3"
        style={{
          background: p.dark.surface,
          border: `${form["--edge"]} solid ${p.dark.border}`,
          borderRadius: r.xl + "px",
        }}
      >
        <p className="text-[11px] font-semibold" style={{ color: p.dark.ink, fontFamily: f.heading }}>
          {t("La app en oscuro")}
        </p>
        <div className="mt-1.5 flex items-center gap-1.5">
          <span
            className="px-2 py-0.5 text-[10px] font-semibold"
            style={{
              background: p.dark.brand,
              color: p.dark["brand-fg"],
              borderRadius: r.md + "px",
              ...caps,
            }}
          >
            {t("Botón")}
          </span>
          <span className="text-[10px]" style={{ color: p.dark.muted, fontFamily: f.body }}>
            {t("texto secundario")}
          </span>
        </div>
      </div>
    </div>
  );
}
