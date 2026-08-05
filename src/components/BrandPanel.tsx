import { useEffect, useRef, useState } from "react";
import { Check, ImagePlus, Loader2, Plus, Trash2, Wand2, X } from "lucide-react";
import {
  BRAND_MOODS,
  type BrandColors,
  type BrandKit,
  brandFormVars,
  brandPalette,
  brandShape,
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

  async function reload() {
    setKits((await listBrandKitsFn()) as Kit[]);
  }
  useEffect(() => {
    reload().catch(() => setKits([]));
  }, []);

  async function activate(id: string) {
    setBusy(true);
    try {
      await activateBrandKitFn({ data: { id } });
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await deleteBrandKitFn({ data: { id } });
      await reload();
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
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{t("Marca")}</h3>
          <p className="mt-0.5 text-xs text-muted">
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
                {k.fonts?.heading || k.fonts?.body || t("Fuentes del sistema")}
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
                <button
                  onClick={() => setEditing(k)}
                  className="rounded-lg px-2.5 py-1.5 text-xs font-semibold hover:bg-surface-3"
                >
                  {t("Editar")}
                </button>
                <button
                  disabled={busy}
                  onClick={() => remove(k.id)}
                  aria-label={t("Eliminar")}
                  className="rounded-lg p-1.5 text-muted hover:bg-surface-3 hover:text-ink"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
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
  // La muestra pinta lo MISMO que produce el tono: su radio, su grosor de línea, su
  // sombra y su tipografía. Antes sólo variaba el teñido —diferencias de 1 a 7% sobre un
  // cuadro de 36px— y los siete se veían idénticos.
  const r = Math.min(s.radius, 14);
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
          style={{ background: p.brand, borderRadius: `${Math.min(s.radius, 99)}px` }}
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

function KitSwatch({ kit }: { kit: BrandKit }) {
  const p = brandPalette(kit).light;
  return (
    <div
      className="flex h-11 w-11 shrink-0 flex-col justify-end gap-1 rounded-lg border border-black/10 p-1.5"
      style={{ background: p.surface }}
    >
      <div className="flex gap-1">
        <span className="h-2 w-2 rounded-full" style={{ background: p.brand }} />
        <span className="h-2 w-2 rounded-full" style={{ background: p["brand-2"] }} />
      </div>
    </div>
  );
}

// ── Editor ──────────────────────────────────────────────────────────────────

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
  const [logoUrl, setLogoUrl] = useState(kit?.logoUrl ?? "");
  const [logoKey, setLogoKey] = useState(kit?.logoKey ?? "");
  const [mood, setMood] = useState(kit?.mood ?? "");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<null | "save" | "url" | "logo">(null);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // El preview usa el mismo derivador que el servidor, así que no puede mentir.
  const preview: BrandKit = {
    id: "preview",
    name: name || t("Marca"),
    colors,
    fonts: { heading: heading || undefined, body: body || undefined },
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
      if (out.fonts?.heading) setHeading(out.fonts.heading);
      if (out.fonts?.body) setBody(out.fonts.body);
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
          fonts: heading || body ? { heading: heading || undefined, body: body || undefined } : null,
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

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{kit ? t("Editar marca") : t("Nueva marca")}</h3>
        <button onClick={onCancel} aria-label={t("Cerrar")} className="rounded-lg p-1.5 hover:bg-surface-3">
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Sacarla de una página: es el camino rápido y por eso va arriba del formulario. */}
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

      <div className="grid gap-4 md:grid-cols-2">
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
            <div className="mt-1 flex items-center gap-3">
              <div className="flex h-14 w-24 items-center justify-center rounded-lg border border-border bg-surface-2 p-1.5">
                {logoUrl ? (
                  <img src={logoUrl} alt="" className="max-h-full max-w-full object-contain" />
                ) : (
                  <ImagePlus className="h-4 w-4 text-muted" />
                )}
              </div>
              <div className="flex flex-col gap-1">
                <button
                  disabled={busy !== null}
                  onClick={() => fileRef.current?.click()}
                  className="rounded-lg bg-surface-3 px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                >
                  {busy === "logo" ? t("Subiendo…") : t("Subir")}
                </button>
                {logoUrl && (
                  <button
                    onClick={() => {
                      setLogoUrl("");
                      setLogoKey("");
                    }}
                    className="rounded-lg px-3 py-1.5 text-xs text-muted hover:text-ink"
                  >
                    {t("Quitar")}
                  </button>
                )}
              </div>
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

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs font-semibold">{t("Fuente de títulos")}</label>
              <input
                value={heading}
                onChange={(e) => setHeading(e.target.value)}
                placeholder="Playfair Display"
                className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-semibold">{t("Fuente de texto")}</label>
              <input
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Inter"
                className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div>
            <label className="text-xs font-semibold">{t("Tono")}</label>
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
        </div>

        <BrandPreview kit={preview} />
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}

      <div className="flex justify-end gap-2">
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

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-muted">{t("Así se va a ver")}</p>

      {/* Formulario público */}
      <div className="rounded-xl p-3" style={{ background: form["--paper"], border: `1px solid ${form["--line"]}` }}>
        {kit.logoUrl && <img src={kit.logoUrl} alt="" className="mb-2 max-h-6 max-w-[50%] object-contain" />}
        <p className="text-sm font-semibold" style={{ color: form["--ink"] }}>
          {t("Formulario")}
        </p>
        <p className="mt-0.5 text-[11px]" style={{ color: form["--muted"] }}>
          {t("Cuéntanos de tu caso")}
        </p>
        <div className="mt-2 h-1 rounded-full" style={{ background: form["--tint"] }}>
          <div className="h-1 w-1/3 rounded-full" style={{ background: form["--accent"] }} />
        </div>
        <span
          className="mt-2 inline-block rounded-lg px-2.5 py-1 text-[11px] font-semibold"
          style={{ background: form["--accent"], color: p.light["brand-fg"] }}
        >
          {t("Enviar")}
        </span>
      </div>

      {/* Documento en papel */}
      <div className="rounded-xl border border-border bg-white p-3">
        {kit.logoUrl && (
          <img
            src={kit.logoUrl}
            alt=""
            className="mb-1.5 max-h-5 max-w-[40%] object-contain pb-1.5"
            style={{ borderBottom: `2px solid ${p.light.brand}` }}
          />
        )}
        <p className="text-[11px] font-bold" style={{ color: p.light.ink }}>
          {t("Documento")}
        </p>
        <div className="mt-1 space-y-1">
          <div className="h-1 w-full rounded" style={{ background: p.light.border }} />
          <div className="h-1 w-4/5 rounded" style={{ background: p.light.border }} />
        </div>
      </div>

      {/* La app, en oscuro: es donde se nota si la marca aguanta el modo noche. */}
      <div className="rounded-xl p-3" style={{ background: p.dark.surface, border: `1px solid ${p.dark.border}` }}>
        <p className="text-[11px] font-semibold" style={{ color: p.dark.ink }}>
          {t("La app en oscuro")}
        </p>
        <div className="mt-1.5 flex items-center gap-1.5">
          <span
            className="rounded-md px-2 py-0.5 text-[10px] font-semibold"
            style={{ background: p.dark.brand, color: p.dark["brand-fg"] }}
          >
            {t("Botón")}
          </span>
          <span className="text-[10px]" style={{ color: p.dark.muted }}>
            {t("texto secundario")}
          </span>
        </div>
      </div>
    </div>
  );
}
