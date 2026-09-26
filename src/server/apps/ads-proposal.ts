// Propuesta de campaña de Ghosty Ads: validación y números. Puro (sin DB ni red) para
// probarlo y para que la tarjeta muestre las mismas cuentas que el servidor.
//
// El contrato con gs está en ghosty-studio/docs/claude/ghosty-ads-app.md: montos en PESOS
// MXN (gs convierte a centavos para Meta) y fechas en ISO.

export type Targeting = {
  ageMin: number;
  ageMax: number;
  countries?: string[];
  cities?: { key: string; name?: string; radiusKm?: number }[];
  interests?: { id: string; name: string }[];
};

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

export type Proposal = {
  name: string;
  /** Botón del anuncio; sin él gs usa MESSAGE_PAGE. */
  cta?: CtaType;
  message: string;
  headline?: string;
  mediaUrl: string;
  greeting?: string;
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
  const min = ageMin == null ? AGE_DEFAULT.min : Math.round(Number(ageMin));
  const max = ageMax == null ? AGE_DEFAULT.max : Math.round(Number(ageMax));
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 18 || max > 65 || min > max)
    return "la edad va de 18 a 65 y la mínima no puede pasar a la máxima";
  const countries = Array.isArray(t.countries)
    ? t.countries.map((c) => String(c).trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c))
    : [];
  const cities: NonNullable<Targeting["cities"]> = [];
  if (Array.isArray(t.cities)) {
    for (const c of t.cities as Record<string, unknown>[]) {
      const key = str(c?.key, 40);
      if (!key) return "cada ciudad lleva su `key` de Meta";
      const radius = c?.radiusKm ?? c?.radius_km;
      const radiusKm = radius == null ? undefined : Math.round(Number(radius));
      if (radiusKm != null && (!Number.isFinite(radiusKm) || radiusKm < 1 || radiusKm > 80)) return "el radio de una ciudad va de 1 a 80 km";
      cities.push({ key, ...(c?.name ? { name: str(c.name, 80) } : {}), ...(radiusKm != null ? { radiusKm } : {}) });
    }
  }
  const interests: NonNullable<Targeting["interests"]> = [];
  if (Array.isArray(t.interests)) {
    for (const i of t.interests as Record<string, unknown>[]) {
      const id = str(i?.id, 40);
      const name = str(i?.name, 80);
      // Los ids de Meta son numéricos: uno inventado («cocina») sale de aquí antes de llegar a Meta.
      if (!/^\d{5,}$/.test(id) || !name) return "cada interés lleva el `id` y el `name` que devolvió ads_interest_search (no los inventes)";
      interests.push({ id, name });
    }
    if (interests.length > 25) return "máximo 25 intereses";
  }
  if (!countries.length && !cities.length) countries.push("MX");
  return {
    ageMin: min,
    ageMax: max,
    ...(countries.length ? { countries } : {}),
    ...(cities.length ? { cities } : {}),
    ...(interests.length ? { interests } : {}),
  };
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
  const greeting = str(raw.greeting, 300);
  const ctaRaw = str(raw.cta, 40).toUpperCase();
  if (ctaRaw && !isCta(ctaRaw)) return `\`cta\` va como uno de: ${CTA_TYPES.join(", ")}`;
  const cta = (ctaRaw || CTA_DEFAULT) as CtaType;
  const mediaUrl = str(raw.media_url ?? raw.mediaUrl, 2000);
  if (!mediaUrl) return "falta el creativo en `media_url`: una imagen o video público (https) o un adjunto del room";
  if (!isMediaUrl(mediaUrl)) return "`media_url` tiene que ser https o un adjunto del room (/api/attachment/…)";
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
  dailyBudget?: number;
  endTime?: string;
  cta?: string;
  /** Intereses que se quitan con la «×» de su chip. */
  removeInterestIds?: string[];
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
  const interests = (current.targeting?.interests ?? []).filter((i) => !remove.has(i.id));
  const { interests: _i, ...restTargeting } = current.targeting ?? { ageMin: AGE_DEFAULT.min, ageMax: AGE_DEFAULT.max };
  const merged = {
    name: edit.name ?? current.name,
    message: edit.message ?? current.message,
    headline: edit.headline ?? current.headline ?? "",
    greeting: edit.greeting ?? current.greeting ?? "",
    media_url: current.mediaUrl,
    cta: edit.cta ?? current.cta ?? CTA_DEFAULT,
    targeting: { ...restTargeting, ...(interests.length ? { interests } : {}) },
    daily_budget: edit.dailyBudget ?? current.dailyBudget,
    end_time: edit.endTime ?? current.endTime,
  };
  return parseProposal(merged, nowMs);
}

const FIELD_KEYS = ["name", "message", "headline", "greeting", "cta", "dailyBudget", "endTime", "targeting", "mediaUrl"] as const;
export type ProposalField = (typeof FIELD_KEYS)[number];

/** Qué cambió entre dos versiones (para la línea del hilo y el contexto de @ads). */
export function changedFields(prev: Partial<Proposal>, next: Partial<Proposal>): ProposalField[] {
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return FIELD_KEYS.filter((k) => {
    if (k === "cta") return (prev.cta ?? CTA_DEFAULT) !== (next.cta ?? CTA_DEFAULT);
    if (k === "headline" || k === "greeting") return (prev[k] ?? "") !== (next[k] ?? "");
    return !same(prev[k], next[k]);
  });
}

const FIELD_LABEL: Record<ProposalField, string> = {
  name: "el título",
  message: "el copy",
  headline: "el encabezado",
  greeting: "el saludo",
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

/** Fecha de fin desde un `<input type="date">`: ese día a las 23:59 en la Ciudad de México. */
export function endTimeFromDate(date: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T23:59:00-06:00` : date;
}

// ── El embudo: gasto → mensajes → leads → calificados ────────────────────────

export type Funnel = {
  spend: number;
  conversations: number;
  leads: number;
  qualified: number;
  /** Costo por lead calificado: EL número. null sin calificados (no es 0 ni infinito). */
  costPerQualified: number | null;
  costPerLead: number | null;
  costPerConversation: number | null;
};

const per = (spend: number, n: number) => (n > 0 ? Math.round((spend / n) * 100) / 100 : null);

export function funnelOf(x: { spend?: number; conversations?: number; leads?: number; qualified?: number }): Funnel {
  const spend = Number(x.spend ?? 0) || 0;
  const conversations = Number(x.conversations ?? 0) || 0;
  const leads = Number(x.leads ?? 0) || 0;
  const qualified = Number(x.qualified ?? 0) || 0;
  return {
    spend,
    conversations,
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
