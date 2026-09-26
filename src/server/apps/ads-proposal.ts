// Propuesta de campaña de Ghosty Ads: validación y números. Puro (sin DB ni red) para
// probarlo y para que la tarjeta muestre las mismas cuentas que el servidor.
//
// El contrato con gs está en ghosty-studio/docs/claude/ghosty-ads-app.md: montos en PESOS
// MXN (gs convierte a centavos para Meta) y fechas en ISO.

export type Targeting = {
  ageMin: number;
  ageMax: number;
  countries?: string[];
  /** Estados (regiones de Meta), con su key de `locations`. */
  regions?: { key: string; name?: string }[];
  cities?: { key: string; name?: string; radiusKm?: number }[];
  interests?: { id: string; name: string }[];
  /**
   * Comportamientos de Meta (p.ej. «Administradores de páginas de negocios»). No se editan en la
   * tarjeta, pero VIAJAN siempre: una segmentación que los perdiera los borraría del público.
   */
  behaviors?: { id: string; name: string }[];
  /** Dónde sale: sin esto, Meta elige (Advantage+ placements). */
  publisherPlatforms?: PublisherPlatform[];
};

export const PUBLISHER_PLATFORMS = ["facebook", "instagram", "messenger", "audience_network"] as const;
export type PublisherPlatform = (typeof PUBLISHER_PLATFORMS)[number];
export const PLATFORM_LABELS: Record<PublisherPlatform, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  messenger: "Messenger",
  audience_network: "Audience Network",
};

/** Valida plataformas (string = por qué no). Vacío o ausente = Meta elige. */
export function parsePlatforms(raw: unknown): PublisherPlatform[] | string | undefined {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) return "`publisherPlatforms` va como lista (facebook, instagram, messenger, audience_network)";
  const out = [...new Set(raw.map((x) => String(x).trim().toLowerCase()))];
  const bad = out.find((x) => !(PUBLISHER_PLATFORMS as readonly string[]).includes(x));
  if (bad) return `plataforma desconocida «${bad}»: usa ${PUBLISHER_PLATFORMS.join(", ")}`;
  return out.length ? (out as PublisherPlatform[]) : undefined;
}

/** Botones (call to action) que gs acepta en `proposal.cta`; todos probados con la vista previa de Meta. */
export const CTA_TYPES = [
  "MESSAGE_PAGE",
  "GET_QUOTE",
  "SHOP_NOW",
  "BOOK_NOW",
  "ORDER_NOW",
  "LEARN_MORE",
  "GET_OFFER",
  "CONTACT_US",
  "SIGN_UP",
  "APPLY_NOW",
] as const;
export type CtaType = (typeof CTA_TYPES)[number];
export const CTA_DEFAULT: CtaType = "MESSAGE_PAGE";

/** Cómo se lee cada botón en el anuncio (copy de la UI: pasa por t()). */
export const CTA_LABELS: Record<CtaType, string> = {
  MESSAGE_PAGE: "Enviar mensaje",
  GET_QUOTE: "Solicitar cotización",
  SHOP_NOW: "Comprar",
  BOOK_NOW: "Reservar",
  ORDER_NOW: "Pedir ahora",
  LEARN_MORE: "Más información",
  GET_OFFER: "Obtener oferta",
  CONTACT_US: "Contactarnos",
  SIGN_UP: "Registrarte",
  APPLY_NOW: "Solicitar",
};

export function isCta(v: unknown): v is CtaType {
  return (CTA_TYPES as readonly string[]).includes(String(v));
}

/** Botones de un anuncio con `link` (columna derecha, va a un sitio); el mismo set que gs. */
export const WEB_CTA_TYPES = ["LEARN_MORE", "SIGN_UP", "GET_OFFER", "CONTACT_US", "APPLY_NOW", "SHOP_NOW", "BOOK_NOW", "GET_QUOTE"] as const;
export const WEB_CTA_DEFAULT: CtaType = "LEARN_MORE";

/** El link de un anuncio web: https o nada. */
export function webLinkOf(v: unknown): string | null {
  const raw = String(v ?? "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

const looksLikeVideo = (url: string) => /\.(mp4|mov|m4v|webm)(\?|#|$)/i.test(url);

export type Proposal = {
  name: string;
  /** Botón del anuncio; sin él gs usa MESSAGE_PAGE. */
  cta?: CtaType;
  message: string;
  headline?: string;
  mediaUrl: string;
  greeting?: string;
  /** Sitio al que lleva. Con él el anuncio sale en la columna derecha de Facebook (escritorio,
   *  sólo imagen) en vez de abrir Messenger. */
  link?: string;
  targeting: Targeting;
  dailyBudget: number;
  endTime: string;
};

/** Lo que guarda la fila además de la propuesta: el estimado y la vista previa de Meta. */
export type StoredProposal = Proposal & {
  estimate?: { lower: number; upper: number } | null;
  previewSrc?: string | null;
  /** Lo que dice Meta cuando no hay vista previa (p.ej. en video). */
  previewNote?: string | null;
};

export const AGE_DEFAULT = { min: 25, max: 55 };
/** Lo que Meta permite: edad 18–65 y radio de ciudad 17–80 km (25 por default al agregarla). */
export const AGE_LIMITS = { min: 18, max: 65 };
export const RADIUS_LIMITS = { min: 17, max: 80, default: 25 };
export const BUDGET_MIN = 20;
export const BUDGET_MAX = 50_000;
const MAX_DAYS = 90;

const str = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);

/** ¿Es un creativo que gs puede bajar? Una URL pública https o un adjunto del room. */
export function isMediaUrl(url: string): boolean {
  return /^https:\/\/\S+$/i.test(url) || /^(https?:\/\/[^/]+)?\/api\/attachment\/[^/?#\s]+/.test(url);
}

/** El fileId de un adjunto del room (`/api/attachment/<id>`, relativo o absoluto), o null. */
export function attachmentIdOf(url: string): string | null {
  const m = String(url ?? "").match(/^(?:https?:\/\/[^/]+)?\/api\/attachment\/([^/?#\s]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Valida la segmentación (string = por qué no). Edad 25–55 si no se dice. */
export function parseTargeting(raw: unknown): Targeting | string {
  const t = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const ageMin = t.ageMin ?? t.age_min;
  const ageMax = t.ageMax ?? t.age_max;
  const min = ageMin == null ? AGE_DEFAULT.min : Number(ageMin);
  const max = ageMax == null ? AGE_DEFAULT.max : Number(ageMax);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < AGE_LIMITS.min || max > AGE_LIMITS.max || min > max)
    return `la edad va de ${AGE_LIMITS.min} a ${AGE_LIMITS.max} y la mínima no puede pasar a la máxima`;
  const countries = Array.isArray(t.countries)
    ? [...new Set(t.countries.map((c) => String(c).trim().toUpperCase()))]
    : [];
  if (countries.some((c) => !/^[A-Z]{2}$/.test(c))) return "cada país va con su código ISO de 2 letras (MX, US…)";
  const regions: NonNullable<Targeting["regions"]> = [];
  if (Array.isArray(t.regions)) {
    for (const r of t.regions as Record<string, unknown>[]) {
      const key = str(r?.key, 40);
      if (!/^\d+$/.test(key)) return "cada estado lleva la `key` que devolvió la búsqueda de zonas";
      if (!regions.some((x) => x.key === key)) regions.push({ key, ...(r?.name ? { name: str(r.name, 80) } : {}) });
    }
  }
  const cities: NonNullable<Targeting["cities"]> = [];
  if (Array.isArray(t.cities)) {
    for (const c of t.cities as Record<string, unknown>[]) {
      const key = str(c?.key, 40);
      if (!key) return "cada ciudad lleva su `key` de Meta";
      const radius = c?.radiusKm ?? c?.radius_km;
      const radiusKm = radius == null ? undefined : Math.round(Number(radius));
      if (radiusKm != null && (!Number.isFinite(radiusKm) || radiusKm < RADIUS_LIMITS.min || radiusKm > RADIUS_LIMITS.max))
        return `el radio de una ciudad va de ${RADIUS_LIMITS.min} a ${RADIUS_LIMITS.max} km`;
      if (!cities.some((x) => x.key === key)) cities.push({ key, ...(c?.name ? { name: str(c.name, 80) } : {}), ...(radiusKm != null ? { radiusKm } : {}) });
    }
  }
  if (countries.length + regions.length + cities.length > 50) return "máximo 50 zonas";
  const interests: NonNullable<Targeting["interests"]> = [];
  if (Array.isArray(t.interests)) {
    for (const i of t.interests as Record<string, unknown>[]) {
      const id = str(i?.id, 40);
      const name = str(i?.name, 80);
      // Los ids de Meta son numéricos: uno inventado («cocina») sale de aquí antes de llegar a Meta.
      if (!/^\d{5,}$/.test(id) || !name) return "cada interés lleva el `id` y el `name` que devolvió ads_interest_search (no los inventes)";
      if (!interests.some((x) => x.id === id)) interests.push({ id, name });
    }
    if (interests.length > 25) return "máximo 25 intereses";
  }
  const behaviors: NonNullable<Targeting["behaviors"]> = [];
  if (Array.isArray(t.behaviors)) {
    for (const b of t.behaviors as Record<string, unknown>[]) {
      const id = str(b?.id, 40);
      if (!/^\d{5,}$/.test(id)) return "cada comportamiento lleva el `id` que dio Meta";
      if (!behaviors.some((x) => x.id === id)) behaviors.push({ id, name: str(b?.name, 80) || id });
    }
  }
  const platforms = parsePlatforms(t.publisherPlatforms ?? t.publisher_platforms);
  if (typeof platforms === "string") return platforms;
  // Sin ninguna zona, México (lo mismo que haría gs).
  if (!countries.length && !regions.length && !cities.length) countries.push("MX");
  return {
    ageMin: min,
    ageMax: max,
    ...(countries.length ? { countries } : {}),
    ...(regions.length ? { regions } : {}),
    ...(cities.length ? { cities } : {}),
    ...(interests.length ? { interests } : {}),
    ...(behaviors.length ? { behaviors } : {}),
    ...(platforms ? { publisherPlatforms: platforms } : {}),
  };
}

// ── Zonas en la tarjeta ──────────────────────────────────────────────────────

export type Zone = { kind: "country"; code: string } | { kind: "region"; key: string } | { kind: "city"; key: string };

/** Cuántas zonas se VEN en la tarjeta (países, estados y ciudades). */
export function zoneCount(t: Partial<Targeting>): number {
  return (t.countries?.length ?? 0) + (t.regions?.length ?? 0) + (t.cities?.length ?? 0);
}

/**
 * ¿Esa zona lleva «×»? Con 2 o más visibles, TODAS (México incluido); sólo la única que
 * queda va sin «×»: sin zona gs usa México y quitarla no cambiaría nada.
 */
export function zoneRemovable(t: Partial<Targeting>): boolean {
  return zoneCount(t) > 1;
}

/** La segmentación sin esa zona. Quitar México con otra zona deja sólo la otra. */
export function removeZone<T extends Partial<Targeting>>(t: T, z: Zone): T {
  if (z.kind === "country") return { ...t, countries: (t.countries ?? []).filter((c) => c !== z.code) };
  if (z.kind === "region") return { ...t, regions: (t.regions ?? []).filter((r) => r.key !== z.key) };
  return { ...t, cities: (t.cities ?? []).filter((c) => c.key !== z.key) };
}

/** Días que dura la campaña desde `nowMs` hasta `endTime` (mínimo 1). */
export function campaignDays(endTime: string, nowMs: number): number {
  const end = Date.parse(endTime);
  if (!Number.isFinite(end)) return 1;
  return Math.max(1, Math.ceil((end - nowMs) / 86_400_000));
}

/** El techo de gasto: presupuesto diario × días que quedan. Es lo máximo que Meta puede cobrar. */
export function maxTotal(dailyBudget: number, endTime: string, nowMs: number): number {
  return Math.round(dailyBudget * campaignDays(endTime, nowMs) * 100) / 100;
}

/** Valida un presupuesto diario en pesos (string = por qué no). */
export function budgetRejection(dailyBudget: number): string | null {
  if (!Number.isFinite(dailyBudget)) return "el presupuesto diario va en pesos, como número";
  if (dailyBudget < BUDGET_MIN) return `el presupuesto diario mínimo es de $${BUDGET_MIN} MXN`;
  if (dailyBudget > BUDGET_MAX) return `el presupuesto diario máximo aquí es de $${BUDGET_MAX.toLocaleString("es-MX")} MXN`;
  return null;
}

/**
 * Valida lo que manda `ads_proposal_submit` (snake_case o camelCase). String = el error que
 * lee el modelo, dicho para que lo corrija.
 */
export function parseProposal(raw: Record<string, unknown>, nowMs: number): Proposal | string {
  const name = str(raw.name, 80);
  if (name.length < 3) return "ponle `name` a la campaña (3 a 80 letras)";
  const message = str(raw.message, 1000);
  if (message.length < 10) return "falta el copy en `message` (el texto principal del anuncio)";
  const headline = str(raw.headline, 80);
  const linkRaw = str(raw.link, 2000);
  const link = webLinkOf(linkRaw);
  if (linkRaw && !link) return "`link` tiene que ser una URL https (el sitio al que lleva el anuncio)";
  // Un anuncio web no abre Messenger: sin saludo.
  const greeting = link ? "" : str(raw.greeting, 300);
  let ctaRaw = str(raw.cta, 40).toUpperCase();
  if (ctaRaw && !isCta(ctaRaw)) return `\`cta\` va como uno de: ${CTA_TYPES.join(", ")}`;
  // Al pasar a web, «Enviar mensaje» (el default de Messenger) se vuelve «Más información».
  if (link && ctaRaw === "MESSAGE_PAGE") ctaRaw = WEB_CTA_DEFAULT;
  if (link && ctaRaw && !(WEB_CTA_TYPES as readonly string[]).includes(ctaRaw))
    return `con \`link\` el \`cta\` va como uno de: ${WEB_CTA_TYPES.join(", ")}`;
  const cta = (ctaRaw || (link ? WEB_CTA_DEFAULT : CTA_DEFAULT)) as CtaType;
  const mediaUrl = str(raw.media_url ?? raw.mediaUrl, 2000);
  if (!mediaUrl) return "falta el creativo en `media_url`: una imagen o video público (https) o un adjunto del room";
  if (!isMediaUrl(mediaUrl)) return "`media_url` tiene que ser https o un adjunto del room (/api/attachment/…)";
  if (link && looksLikeVideo(mediaUrl)) return "la columna derecha sólo acepta imagen (cuadrada, 1080×1080): cambia `media_url`";
  const targeting = parseTargeting(raw.targeting);
  if (typeof targeting === "string") return targeting;
  const dailyBudget = Math.round(Number(raw.daily_budget ?? raw.dailyBudget) * 100) / 100;
  const b = budgetRejection(dailyBudget);
  if (b) return b;
  const endRaw = str(raw.end_time ?? raw.endTime, 40);
  const end = Date.parse(endRaw);
  if (!Number.isFinite(end)) return "`end_time` va en ISO (2026-10-31T23:59:00-06:00)";
  if (end < nowMs + 3_600_000) return "`end_time` tiene que quedar al menos una hora en el futuro";
  if (end > nowMs + MAX_DAYS * 86_400_000) return `la campaña dura máximo ${MAX_DAYS} días; propón una fecha de fin más cercana`;
  return {
    name,
    message,
    ...(headline ? { headline } : {}),
    mediaUrl,
    ...(greeting ? { greeting } : {}),
    ...(link ? { link } : {}),
    cta,
    targeting,
    dailyBudget,
    endTime: new Date(end).toISOString(),
  };
}

// ── Versiones y edición en línea ─────────────────────────────────────────────

/** Los campos que una persona edita desde la tarjeta (el resto lo cambia @ads). */
export type ProposalEdit = {
  name?: string;
  message?: string;
  headline?: string;
  greeting?: string;
  link?: string;
  dailyBudget?: number;
  endTime?: string;
  cta?: string;
  /** Intereses que se quitan con la «×» de su chip. */
  removeInterestIds?: string[];
  /** La segmentación completa editada en la tarjeta (edad, zonas, intereses). */
  targeting?: Targeting;
};

/**
 * `ads_proposal_submit` en un hilo que ya tiene campaña: si sigue en propuesta, es una
 * VERSIÓN nueva de la misma tarjeta; si ya se creó, se canceló o falló, es una campaña nueva.
 */
export function submitMode(existing: { status: string } | null): "version" | "new" {
  return existing?.status === "proposal" ? "version" : "new";
}

/**
 * Aplica una edición de la tarjeta y la valida con las MISMAS reglas que la propuesta de
 * @ads (string = por qué no). Quitar el último interés deja la segmentación amplia.
 */
export function applyEdit(current: Proposal, edit: ProposalEdit, nowMs: number): Proposal | string {
  const remove = new Set(edit.removeInterestIds ?? []);
  const base = edit.targeting ?? current.targeting ?? { ageMin: AGE_DEFAULT.min, ageMax: AGE_DEFAULT.max };
  const interests = (base.interests ?? []).filter((i) => !remove.has(i.id));
  const { interests: _i, ...restTargeting } = base;
  const merged = {
    name: edit.name ?? current.name,
    message: edit.message ?? current.message,
    headline: edit.headline ?? current.headline ?? "",
    greeting: edit.greeting ?? current.greeting ?? "",
    link: edit.link ?? current.link ?? "",
    media_url: current.mediaUrl,
    cta: edit.cta ?? current.cta ?? CTA_DEFAULT,
    targeting: { ...restTargeting, ...(interests.length ? { interests } : {}) },
    daily_budget: edit.dailyBudget ?? current.dailyBudget,
    end_time: edit.endTime ?? current.endTime,
  };
  return parseProposal(merged, nowMs);
}

const FIELD_KEYS = ["name", "message", "headline", "greeting", "link", "cta", "dailyBudget", "endTime", "targeting", "mediaUrl"] as const;
export type ProposalField = (typeof FIELD_KEYS)[number];

/** Qué cambió entre dos versiones (para la línea del hilo y el contexto de @ads). */
export function changedFields(prev: Partial<Proposal>, next: Partial<Proposal>): ProposalField[] {
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return FIELD_KEYS.filter((k) => {
    if (k === "cta") return (prev.cta ?? CTA_DEFAULT) !== (next.cta ?? CTA_DEFAULT);
    if (k === "headline" || k === "greeting" || k === "link") return (prev[k] ?? "") !== (next[k] ?? "");
    return !same(prev[k], next[k]);
  });
}

const FIELD_LABEL: Record<ProposalField, string> = {
  name: "el título",
  message: "el copy",
  headline: "el encabezado",
  greeting: "el saludo",
  link: "el link",
  cta: "el botón",
  dailyBudget: "el presupuesto",
  endTime: "la fecha de fin",
  targeting: "la segmentación",
  mediaUrl: "el creativo",
};

/** «el copy», «el copy y el presupuesto», «el copy, el botón y la fecha de fin». */
export function describeChanges(fields: ProposalField[]): string {
  const parts = fields.map((f) => FIELD_LABEL[f]);
  if (!parts.length) return "la propuesta";
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} y ${parts[parts.length - 1]}`;
}

/** Los campos que manda `ads_proposal_submit` (snake_case, como su inputSchema). */
const SUBMIT_KEYS = ["name", "message", "headline", "greeting", "link", "cta", "media_url", "targeting", "daily_budget", "end_time"] as const;

/**
 * `ads_proposal_submit` sobre una propuesta abierta: lo que NO se manda se hereda de la
 * vigente (merge superficial por campo; `targeting` se reemplaza entero si viene). Así
 * «cambia la zona» es mandar sólo `targeting`, sin pisar el copy que editó una persona.
 * Acepta también las llaves camelCase de la propuesta.
 */
export function mergeSubmit(current: Proposal, raw: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = {
    name: current.name,
    message: current.message,
    headline: current.headline ?? "",
    greeting: current.greeting ?? "",
    link: current.link ?? "",
    cta: current.cta ?? CTA_DEFAULT,
    media_url: current.mediaUrl,
    targeting: current.targeting,
    daily_budget: current.dailyBudget,
    end_time: current.endTime,
  };
  const camel: Record<string, string> = { media_url: "mediaUrl", daily_budget: "dailyBudget", end_time: "endTime" };
  for (const k of SUBMIT_KEYS) {
    const v = raw[k] !== undefined && raw[k] !== null ? raw[k] : camel[k] ? raw[camel[k]] : undefined;
    if (v !== undefined && v !== null) base[k] = v;
  }
  return base;
}

/** La propuesta en una línea por campo, para el contexto de @ads (no tiene que preguntarla). */
export function summarizeProposal(p: Proposal): string {
  const t = p.targeting ?? { ageMin: AGE_DEFAULT.min, ageMax: AGE_DEFAULT.max };
  const zones = [
    ...(t.countries ?? []),
    ...(t.regions ?? []).map((r) => r.name ?? r.key),
    ...(t.cities ?? []).map((c) => `${c.name ?? c.key}${c.radiusKm ? ` +${c.radiusKm} km` : ""}`),
  ];
  const cta = p.cta ?? CTA_DEFAULT;
  return [
    `título «${p.name}»`,
    `copy «${p.message.replace(/\s+/g, " ").slice(0, 400)}»`,
    p.headline ? `encabezado «${p.headline}»` : null,
    p.greeting ? `saludo «${p.greeting}»` : null,
    p.link ? `lleva a ${p.link} (anuncio web: columna derecha de Facebook, escritorio, sólo imagen; sin link sería Messenger)` : "lleva a Messenger",
    `botón «${CTA_LABELS[cta] ?? cta}» (cta ${cta}; en tus mensajes di la etiqueta, no el código)`,
    `presupuesto $${p.dailyBudget} MXN al día hasta ${p.endTime}`,
    `zonas ${zones.join(", ") || "MX"}`,
    `edad ${t.ageMin}–${t.ageMax}`,
    `intereses ${(t.interests ?? []).map((i) => i.name).join(", ") || "ninguno (amplia)"}`,
    `creativo ${p.mediaUrl}`,
  ]
    .filter(Boolean)
    .join("; ");
}

// ── Cambios pendientes de una campaña ya creada ──────────────────────────────

/** El anuncio (copy, botón, creativo) de una campaña ya creada: cambiarlo crea un anuncio nuevo. */
export type AdChange = { message: string; headline?: string; cta?: CtaType; mediaUrl: string; link?: string };

/**
 * Lo que se puede cambiar en una campaña que ya está en Meta. `targeting` y `endTime` van por
 * `update_targeting`, las plataformas por `set_placements` y el anuncio por `replace_ad`.
 */
export type LiveChange = { targeting?: Targeting; endTime?: string; publisherPlatforms?: PublisherPlatform[]; ad?: AdChange };

const zonesOf = (t: Partial<Targeting>) => [
  ...(t.countries ?? []),
  ...(t.regions ?? []).map((r) => r.name ?? r.key),
  ...(t.cities ?? []).map((c) => `${c.name ?? c.key}${c.radiusKm ? ` +${c.radiusKm} km` : ""}`),
];

const dayOf = (iso: string | null | undefined) => {
  const d = iso ? new Date(iso) : null;
  return d && Number.isFinite(d.getTime())
    ? d.toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric", timeZone: "America/Mexico_City" }).replace(".", "")
    : "—";
};

const platformsText = (p: PublisherPlatform[] | undefined) => (p?.length ? p.map((x) => PLATFORM_LABELS[x]).join(", ") : "automáticas");

export type LiveState = {
  targeting: Partial<Targeting> | null;
  endTime: string | null;
  message?: string | null;
  headline?: string | null;
  cta?: string | null;
};

/**
 * El diff legible de un cambio pendiente contra lo que hoy tiene Meta: «Edad 25–55 → 25–45»,
 * «Zonas MX → Monterrey +25 km», «Intereses +Remodelación −Ferretería», «Fin 31 oct → …»,
 * «Ubicaciones automáticas → Facebook, Instagram», «Anuncio nuevo: copy y botón». Sólo lo que cambia.
 */
export function liveChangeDiff(current: LiveState, change: LiveChange): string[] {
  const out: string[] = [];
  const a = current.targeting ?? {};
  const b = change.targeting;
  if (b) {
    if (a.ageMin !== b.ageMin || a.ageMax !== b.ageMax) out.push(`Edad ${a.ageMin ?? "?"}–${a.ageMax ?? "?"} → ${b.ageMin}–${b.ageMax}`);
    const za = zonesOf(a).join(", ") || "MX";
    const zb = zonesOf(b).join(", ") || "MX";
    if (za !== zb) out.push(`Zonas ${za} → ${zb}`);
    const ia = new Map((a.interests ?? []).map((i) => [i.id, i.name]));
    const ib = new Map((b.interests ?? []).map((i) => [i.id, i.name]));
    const added = [...ib].filter(([id]) => !ia.has(id)).map(([, n]) => `+${n}`);
    const removed = [...ia].filter(([id]) => !ib.has(id)).map(([, n]) => `−${n}`);
    if (added.length || removed.length) out.push(`Intereses ${[...added, ...removed].join(" ")}`);
  }
  if (change.endTime && dayOf(change.endTime) !== dayOf(current.endTime)) out.push(`Fin ${dayOf(current.endTime)} → ${dayOf(change.endTime)}`);
  if (change.publisherPlatforms) {
    const pa = platformsText(a.publisherPlatforms);
    const pb = platformsText(change.publisherPlatforms);
    if (pa !== pb) out.push(`Ubicaciones ${pa} → ${pb}`);
  }
  if (change.ad) {
    const what: string[] = [];
    if ((change.ad.message ?? "") !== (current.message ?? "")) what.push("copy");
    if ((change.ad.headline ?? "") !== (current.headline ?? "")) what.push("título");
    if ((change.ad.cta ?? CTA_DEFAULT) !== (current.cta ?? CTA_DEFAULT)) what.push(`botón «${CTA_LABELS[change.ad.cta ?? CTA_DEFAULT]}»`);
    what.push("creativo");
    out.push(`Anuncio nuevo: ${what.join(", ")}`);
  }
  return out;
}

/** Valida un cambio pendiente (string = por qué no). */
export function parseLiveChange(
  raw: { targeting?: unknown; endTime?: unknown; publisherPlatforms?: unknown; ad?: unknown },
  nowMs: number,
): LiveChange | string {
  const out: LiveChange = {};
  if (raw.targeting != null) {
    const t = parseTargeting(raw.targeting);
    if (typeof t === "string") return t;
    // Las plataformas de una campaña creada van aparte (set_placements), no en la segmentación.
    const { publisherPlatforms: tp, ...rest } = t;
    out.targeting = rest;
    if (tp) out.publisherPlatforms = tp;
  }
  if (raw.publisherPlatforms != null) {
    const pp = parsePlatforms(raw.publisherPlatforms);
    if (typeof pp === "string") return pp;
    if (!pp) return "deja al menos una plataforma";
    out.publisherPlatforms = pp;
  }
  if (raw.endTime != null && raw.endTime !== "") {
    const end = Date.parse(String(raw.endTime));
    if (!Number.isFinite(end)) return "la fecha de fin va en ISO";
    if (end < nowMs + 3_600_000) return "la fecha de fin tiene que quedar al menos una hora en el futuro";
    if (end > nowMs + 90 * 86_400_000) return "la campaña dura máximo 90 días más";
    out.endTime = new Date(end).toISOString();
  }
  if (raw.ad != null) {
    const ad = raw.ad as Record<string, unknown>;
    const message = str(ad.message, 1000);
    if (message.length < 10) return "el anuncio nuevo necesita su copy (`message`)";
    const mediaUrl = str(ad.mediaUrl ?? ad.media_url, 2000);
    if (!isMediaUrl(mediaUrl)) return "el anuncio nuevo necesita su creativo: https público o un adjunto del room";
    const ctaRaw = str(ad.cta, 40).toUpperCase();
    if (ctaRaw && !isCta(ctaRaw)) return `\`cta\` va como uno de: ${CTA_TYPES.join(", ")}`;
    const headline = str(ad.headline, 80);
    out.ad = { message, mediaUrl, cta: (ctaRaw || CTA_DEFAULT) as CtaType, ...(headline ? { headline } : {}) };
  }
  if (!out.targeting && !out.endTime && !out.publisherPlatforms && !out.ad)
    return "no hay nada que cambiar: manda targeting, end_time, publisher_platforms o el anuncio nuevo";
  return out;
}

// ── Revisión de Meta y token ─────────────────────────────────────────────────

export type ReviewState = "approved" | "in_review" | "rejected" | "with_issues";
export type Review = { state: ReviewState; reasons: string[] };
const REVIEW_STATES: ReviewState[] = ["approved", "in_review", "rejected", "with_issues"];

/** Normaliza la respuesta de `review` de gs; null si no se entiende. */
export function parseReview(raw: unknown): Review | null {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const state = String(r.state ?? "") as ReviewState;
  if (!REVIEW_STATES.includes(state)) return null;
  const own = Array.isArray(r.reasons) ? r.reasons.map(String) : [];
  const fromAds = Array.isArray(r.ads) ? (r.ads as Record<string, unknown>[]).flatMap((a) => (Array.isArray(a?.reasons) ? a.reasons.map(String) : [])) : [];
  const reasons = [...new Set([...own, ...fromAds].map((x) => x.trim()).filter(Boolean))].slice(0, 6);
  return { state, reasons };
}

export const REVIEW_LABELS: Record<ReviewState, string> = {
  approved: "Aprobado",
  in_review: "En revisión",
  rejected: "Rechazado",
  with_issues: "Con observaciones",
};

/**
 * El aviso del hilo cuando cambia la revisión de Meta; null si no hay que decir nada. Se dice
 * UNA vez por cambio de estado (el anterior se guarda en la fila).
 */
export function reviewNotice(campaignId: number, prev: ReviewState | null, next: Review): string | null {
  if (prev === next.state) return null;
  const why = next.reasons.length ? `: ${next.reasons.join("; ")}` : "";
  if (next.state === "rejected") return `🛑 Meta rechazó el anuncio de #${campaignId}${why}`;
  if (next.state === "with_issues") return `⚠️ Meta marcó observaciones en el anuncio de #${campaignId}${why}`;
  if (next.state === "approved" && prev != null) return `✅ Meta aprobó el anuncio de #${campaignId}.`;
  return null;
}

/** Aviso de token: con 10 días o menos para vencer (null si falta más o no se sabe). */
export function tokenWarning(daysLeft: number | null | undefined, expiresAt: string | null | undefined): string | null {
  if (daysLeft == null || !Number.isFinite(daysLeft) || daysLeft > 10) return null;
  if (daysLeft <= 0) return "La conexión con Meta venció: reconéctala para que las campañas sigan midiéndose.";
  return `Reconecta Meta antes del ${dayOf(expiresAt ?? new Date(Date.now() + daysLeft * 86_400_000).toISOString())} (quedan ${daysLeft} ${daysLeft === 1 ? "día" : "días"}).`;
}

/** Fecha de fin desde un `<input type="date">`: ese día a las 23:59 en la Ciudad de México. */
export function endTimeFromDate(date: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T23:59:00-06:00` : date;
}

// ── El embudo: gasto → mensajes → leads → calificados ────────────────────────

export type Funnel = {
  spend: number;
  /** Conversaciones de Messenger; en un anuncio web (`web`), clics al sitio. */
  conversations: number;
  web?: boolean;
  leads: number;
  qualified: number;
  /** Costo por lead calificado: EL número. null sin calificados (no es 0 ni infinito). */
  costPerQualified: number | null;
  costPerLead: number | null;
  costPerConversation: number | null;
};

const per = (spend: number, n: number) => (n > 0 ? Math.round((spend / n) * 100) / 100 : null);

export function funnelOf(x: { spend?: number; conversations?: number; leads?: number; qualified?: number; web?: boolean }): Funnel {
  const spend = Number(x.spend ?? 0) || 0;
  const conversations = Number(x.conversations ?? 0) || 0;
  const leads = Number(x.leads ?? 0) || 0;
  const qualified = Number(x.qualified ?? 0) || 0;
  return {
    spend,
    conversations,
    ...(x.web ? { web: true } : {}),
    leads,
    qualified,
    costPerQualified: per(spend, qualified),
    costPerLead: per(spend, leads),
    costPerConversation: per(spend, conversations),
  };
}

/** Huella de un reporte: si no cambió nada que se lea, el reporte no se publica. */
export function reportDigest(items: { id: number; funnel: Funnel }[]): string {
  return JSON.stringify(
    [...items]
      .sort((a, b) => a.id - b.id)
      .map((i) => [i.id, Math.round(i.funnel.spend), i.funnel.conversations, i.funnel.leads, i.funnel.qualified]),
  );
}

/** «$1,234.50» en pesos. */
export function mxn(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${n.toLocaleString("es-MX", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
}
