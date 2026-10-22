// Propuesta de campaña de BÚSQUEDA de Google Ads (anuncio de texto adaptable). Puro (sin DB ni
// red) para probarlo y para que la tarjeta valide con las mismas reglas que el servidor.
//
// Contrato con gs (`googleAds("create_paused" | "validate", { proposal })`): montos en la moneda
// de la cuenta de Google Ads, fechas YYYY-MM-DD. gs hace el mutate atómico con validateOnly
// primero; aquí van los guardarraíles que el dueño VE en la tarjeta: concordancia sólo frase o
// exacta, negativas base, ubicación por presencia (la pone gs) y teléfono para medir llamadas.

export type GoogleMatch = "phrase" | "exact";
export type GoogleKeyword = { text: string; match: GoogleMatch; /** Búsquedas al mes (de keyword_ideas); sólo se muestra. */ volume?: number | null };
export type GoogleGeo = { id: string; name: string };
export type GoogleRadius = { lat: number; lng: number; km: number; label: string };

export type GoogleProposal = {
  platform: "google";
  name: string;
  finalUrl: string;
  path1?: string;
  path2?: string;
  headlines: string[];
  descriptions: string[];
  keywords: GoogleKeyword[];
  negatives: string[];
  locations: GoogleGeo[];
  radius?: GoogleRadius;
  phone?: string;
  dailyBudget: number;
  maxCpc?: number;
  endDate?: string;
};

/** Un título o descripción que Google rechazó por política (de `validate`/`create_paused`). */
export type GooglePolicyIssue = { field: "headlines" | "descriptions" | "keywords"; index: number; text: string; reason: string };

/** Lo que guarda la fila: la propuesta y, si Google la rechazó, qué pieza y por qué. */
export type StoredGoogleProposal = GoogleProposal & { policy?: GooglePolicyIssue[] | null };

export const GOOGLE_LIMITS = {
  headline: 30,
  description: 90,
  path: 15,
  headlinesMin: 3,
  headlinesMax: 15,
  descriptionsMin: 2,
  descriptionsMax: 4,
  keywordsMax: 50,
  keywordWords: 10,
  keywordChars: 80,
  negativesMax: 50,
  locationsMax: 50,
  budgetMin: 20,
  budgetMax: 50_000,
  maxDays: 90,
  radiusKm: { min: 1, max: 80 },
} as const;

/** Lo que casi nunca compra: quien busca «gratis», «empleo» o «curso». El dueño las ve y las quita. */
export const BASE_NEGATIVES = ["gratis", "empleo", "trabajo", "curso", "pdf", "qué es"];

/** México (geoTargetConstant 2484): sin zonas, Google mostraría el anuncio en todo el mundo. */
export const GOOGLE_DEFAULT_LOCATION: GoogleGeo = { id: "2484", name: "México" };

const str = (v: unknown, max: number) => String(v ?? "").trim().replace(/\s+/g, " ").slice(0, max);
const raw = (v: unknown) => String(v ?? "").trim().replace(/\s+/g, " ");
const pick = (o: Record<string, unknown>, snake: string, camel: string) => (o[snake] !== undefined ? o[snake] : o[camel]);

/** Sin repetidos (sin importar mayúsculas), en el orden en que llegaron. */
function uniq(xs: string[]): string[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = x.toLocaleLowerCase("es-MX");
    if (!x || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Una palabra clave: `"agente whatsapp"` → frase, `[agente whatsapp]` → exacta; cualquier otra
 * (incluida «amplia» o «broad») se fuerza a FRASE. La amplia quema 20–40 % del presupuesto en
 * búsquedas que no tienen que ver.
 */
export function parseKeyword(k: unknown): GoogleKeyword | string {
  const o = (k && typeof k === "object" ? k : { text: k }) as Record<string, unknown>;
  let text = raw(o.text ?? o.keyword);
  let match: GoogleMatch = String(o.match ?? o.matchType ?? "").toLowerCase() === "exact" ? "exact" : "phrase";
  if (/^\[.*\]$/.test(text)) {
    text = text.slice(1, -1).trim();
    match = "exact";
  } else if (/^".*"$/.test(text)) text = text.slice(1, -1).trim();
  text = text.replace(/^\+/, "").replace(/\s\+/g, " ").toLocaleLowerCase("es-MX");
  if (!text) return "cada palabra clave lleva su `text`";
  if (text.length > GOOGLE_LIMITS.keywordChars) return `la palabra clave «${text.slice(0, 40)}…» pasa de ${GOOGLE_LIMITS.keywordChars} letras`;
  if (text.split(" ").length > GOOGLE_LIMITS.keywordWords) return `la palabra clave «${text}» pasa de ${GOOGLE_LIMITS.keywordWords} palabras`;
  const vol = o.volume ?? o.avgMonthlySearches;
  const volume = vol == null || vol === "" ? null : Math.round(Number(vol));
  return { text, match, ...(volume != null && Number.isFinite(volume) && volume >= 0 ? { volume } : {}) };
}

/** Fecha de hoy (YYYY-MM-DD) en la Ciudad de México. */
export function todayCdmx(nowMs: number): string {
  return new Date(nowMs).toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
}

const dayMs = (d: string) => Date.parse(`${d}T12:00:00Z`);

/** Días de hoy (CDMX) a `endDate`, incluido el último. */
export function googleDays(endDate: string | undefined, nowMs: number): number | null {
  if (!endDate || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return null;
  return Math.max(1, Math.round((dayMs(endDate) - dayMs(todayCdmx(nowMs))) / 86_400_000) + 1);
}

/**
 * El techo que se le enseña al dueño: diario × días hasta el fin, o × 30 si no tiene fin.
 * (Google puede gastar hasta 2× en un día, pero nunca más de ~30.4× el diario en un mes.)
 */
export function googleMaxTotal(dailyBudget: number, endDate: string | undefined, nowMs: number): { total: number; days: number; open: boolean } {
  const d = googleDays(endDate, nowMs);
  const days = d == null ? 30 : Math.min(d, 30);
  return { total: Math.round(dailyBudget * days * 100) / 100, days, open: d == null };
}

/** Normaliza un teléfono para la extensión de llamada (string = por qué no). */
export function parsePhone(v: unknown): string | null | { error: string } {
  const s = raw(v);
  if (!s) return null;
  const digits = s.replace(/[^\d]/g, "");
  if (digits.length < 8 || digits.length > 15) return { error: "el teléfono va con 10 dígitos (o con lada internacional, p.ej. +52 55 1234 5678)" };
  return (s.startsWith("+") ? "+" : "") + digits;
}

/**
 * Valida lo que manda `ads_google_proposal_submit` (snake_case o camelCase) o una edición de la
 * tarjeta. String = el error que lee el modelo o la persona. `baseNegatives`: si no vienen
 * negativas, se ponen las base (sólo al proponer; en una edición la lista vacía es a propósito).
 */
export function parseGoogleProposal(r: Record<string, unknown>, nowMs: number, opts: { baseNegatives?: boolean } = {}): GoogleProposal | string {
  const L = GOOGLE_LIMITS;
  const name = str(r.name, 80);
  if (name.length < 3) return "ponle `name` a la campaña (3 a 80 letras)";
  const urlRaw = raw(pick(r, "final_url", "finalUrl"));
  let finalUrl: string;
  try {
    const u = new URL(urlRaw);
    if (u.protocol !== "https:") throw new Error();
    finalUrl = u.toString();
  } catch {
    return "`final_url` va con la página https a la que llega quien da clic";
  }
  const paths: string[] = [];
  for (const k of ["path1", "path2"]) {
    const p = raw(r[k]).replace(/^\/+|\/+$/g, "").replace(/\s+/g, "-");
    if (p.length > L.path) return `\`${k}\` (lo que se ve después del dominio) va de máximo ${L.path} letras`;
    paths.push(p);
  }
  if (!paths[0] && paths[1]) [paths[0], paths[1]] = [paths[1], ""];

  const headlinesIn = Array.isArray(r.headlines) ? r.headlines.map(raw) : [];
  const headlines = uniq(headlinesIn.filter(Boolean));
  const longH = headlines.findIndex((h) => h.length > L.headline);
  if (longH >= 0) return `el título ${longH + 1} («${headlines[longH]}») tiene ${headlines[longH].length} letras; máximo ${L.headline}`;
  if (headlines.length < L.headlinesMin || headlines.length > L.headlinesMax)
    return `los títulos van de ${L.headlinesMin} a ${L.headlinesMax}, distintos entre sí (hay ${headlines.length}); lo ideal son 10 a 15`;

  const descIn = Array.isArray(r.descriptions) ? r.descriptions.map(raw) : [];
  const descriptions = uniq(descIn.filter(Boolean));
  const longD = descriptions.findIndex((d) => d.length > L.description);
  if (longD >= 0) return `la descripción ${longD + 1} tiene ${descriptions[longD].length} letras; máximo ${L.description}`;
  if (descriptions.length < L.descriptionsMin || descriptions.length > L.descriptionsMax)
    return `las descripciones van de ${L.descriptionsMin} a ${L.descriptionsMax}, distintas entre sí (hay ${descriptions.length})`;

  const keywords: GoogleKeyword[] = [];
  for (const k of Array.isArray(r.keywords) ? r.keywords : []) {
    const kw = parseKeyword(k);
    if (typeof kw === "string") return kw;
    if (!keywords.some((x) => x.text === kw.text && x.match === kw.match)) keywords.push(kw);
  }
  if (!keywords.length) return "falta al menos una palabra clave en `keywords` (frase o exacta)";
  if (keywords.length > L.keywordsMax) return `máximo ${L.keywordsMax} palabras clave por campaña`;

  const negIn = r.negatives;
  const negatives =
    negIn == null && opts.baseNegatives !== false
      ? [...BASE_NEGATIVES]
      : uniq((Array.isArray(negIn) ? negIn : []).map((n) => str(n, L.keywordChars).toLocaleLowerCase("es-MX").replace(/^["[]|["\]]$/g, "")));
  if (negatives.length > L.negativesMax) return `máximo ${L.negativesMax} palabras negativas`;
  // Una negativa igual a una palabra clave apagaría esa palabra: se avisa en vez de callarlo.
  const clash = keywords.find((k) => negatives.includes(k.text));
  if (clash) return `«${clash.text}» está a la vez como palabra clave y como negativa; quítala de una de las dos`;

  const locations: GoogleGeo[] = [];
  for (const l of Array.isArray(r.locations) ? (r.locations as Record<string, unknown>[]) : []) {
    const id = raw(l?.id).replace(/^geoTargetConstants\//, "").slice(0, 20);
    if (!/^\d+$/.test(id)) return "cada ubicación lleva el `id` que devolvió ads_google_location_search (no lo inventes)";
    if (!locations.some((x) => x.id === id)) locations.push({ id, name: str(l?.name, 120) || id });
  }
  if (locations.length > L.locationsMax) return `máximo ${L.locationsMax} ubicaciones`;
  let radius: GoogleRadius | undefined;
  const rr = r.radius as Record<string, unknown> | null | undefined;
  if (rr && typeof rr === "object") {
    const lat = Number(rr.lat);
    const lng = Number(rr.lng);
    const km = Math.round(Number(rr.km));
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return "el radio lleva `lat` y `lng` válidos";
    if (!Number.isFinite(km) || km < L.radiusKm.min || km > L.radiusKm.max) return `el radio va de ${L.radiusKm.min} a ${L.radiusKm.max} km`;
    radius = { lat, lng, km, label: str(rr.label, 120) || `${km} km` };
  }
  if (!locations.length && !radius) locations.push({ ...GOOGLE_DEFAULT_LOCATION });

  const phone = parsePhone(r.phone);
  if (phone && typeof phone === "object") return phone.error;

  const dailyBudget = Math.round(Number(pick(r, "daily_budget", "dailyBudget")) * 100) / 100;
  if (!Number.isFinite(dailyBudget)) return "el presupuesto diario (`daily_budget`) va como número, en la moneda de la cuenta";
  if (dailyBudget < L.budgetMin) return `el presupuesto diario mínimo es de $${L.budgetMin}`;
  if (dailyBudget > L.budgetMax) return `el presupuesto diario máximo aquí es de $${L.budgetMax.toLocaleString("es-MX")}`;
  const cpcRaw = pick(r, "max_cpc", "maxCpc");
  let maxCpc: number | undefined;
  if (cpcRaw != null && cpcRaw !== "") {
    maxCpc = Math.round(Number(cpcRaw) * 100) / 100;
    if (!Number.isFinite(maxCpc) || maxCpc <= 0) return "`max_cpc` (tope por clic) va como número mayor a 0";
    if (maxCpc > dailyBudget) return "el tope por clic no puede pasar del presupuesto diario";
  }
  const endRaw = raw(pick(r, "end_date", "endDate")).slice(0, 10);
  let endDate: string | undefined;
  if (endRaw) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(endRaw) || !Number.isFinite(dayMs(endRaw))) return "`end_date` va como AAAA-MM-DD";
    const days = Math.round((dayMs(endRaw) - dayMs(todayCdmx(nowMs))) / 86_400_000);
    if (days < 1) return "la fecha de fin tiene que ser de mañana en adelante";
    if (days > L.maxDays) return `la campaña dura máximo ${L.maxDays} días; propón una fecha de fin más cercana`;
    endDate = endRaw;
  }
  return {
    platform: "google",
    name,
    finalUrl,
    ...(paths[0] ? { path1: paths[0] } : {}),
    ...(paths[1] ? { path2: paths[1] } : {}),
    headlines,
    descriptions,
    keywords,
    negatives,
    locations,
    ...(radius ? { radius } : {}),
    ...(phone ? { phone } : {}),
    dailyBudget,
    ...(maxCpc != null ? { maxCpc } : {}),
    ...(endDate ? { endDate } : {}),
  };
}

// ── Versiones y edición en la tarjeta ────────────────────────────────────────

/** Lo que una persona edita en la tarjeta. `null` quita un opcional (radio, tope, fin, teléfono). */
export type GoogleProposalEdit = {
  name?: string;
  finalUrl?: string;
  path1?: string;
  path2?: string;
  headlines?: string[];
  descriptions?: string[];
  keywords?: GoogleKeyword[];
  negatives?: string[];
  locations?: GoogleGeo[];
  radius?: GoogleRadius | null;
  phone?: string | null;
  dailyBudget?: number;
  maxCpc?: number | null;
  endDate?: string | null;
};

const EDIT_KEYS = ["name", "finalUrl", "path1", "path2", "headlines", "descriptions", "keywords", "negatives", "locations", "radius", "phone", "dailyBudget", "maxCpc", "endDate"] as const;

/** La propuesta como entrada de `parseGoogleProposal` (camelCase). */
const asInput = (p: Partial<GoogleProposal>): Record<string, unknown> => ({ ...p });

/** Aplica una edición de la tarjeta y la valida con las MISMAS reglas que la propuesta de @ads. */
export function applyGoogleEdit(current: GoogleProposal, edit: GoogleProposalEdit, nowMs: number): GoogleProposal | string {
  const merged = asInput(current);
  for (const k of EDIT_KEYS) {
    if (!(k in edit)) continue;
    const v = edit[k];
    if (v === null) delete merged[k];
    else if (v !== undefined) merged[k] = v;
  }
  // Una palabra que se queda trae su volumen de antes (la tarjeta puede mandarla sin él).
  if (edit.keywords) {
    const vol = new Map(current.keywords.map((k) => [k.text, k.volume]));
    merged.keywords = edit.keywords.map((k) => ({ ...k, volume: k.volume ?? vol.get(String(k.text ?? "").toLocaleLowerCase("es-MX")) ?? null }));
  }
  return parseGoogleProposal(merged, nowMs, { baseNegatives: false });
}

const SUBMIT_KEYS: [string, string][] = [
  ["name", "name"],
  ["final_url", "finalUrl"],
  ["path1", "path1"],
  ["path2", "path2"],
  ["headlines", "headlines"],
  ["descriptions", "descriptions"],
  ["keywords", "keywords"],
  ["negatives", "negatives"],
  ["locations", "locations"],
  ["radius", "radius"],
  ["phone", "phone"],
  ["daily_budget", "dailyBudget"],
  ["max_cpc", "maxCpc"],
  ["end_date", "endDate"],
];

/**
 * `ads_google_proposal_submit` sobre una propuesta abierta: lo que NO se manda se hereda de la
 * vigente (merge por campo; las listas se reemplazan enteras si vienen). "" quita un opcional.
 */
export function mergeGoogleSubmit(current: GoogleProposal, r: Record<string, unknown>): Record<string, unknown> {
  const out = asInput(current);
  for (const [snake, camel] of SUBMIT_KEYS) {
    const v = r[snake] !== undefined && r[snake] !== null ? r[snake] : r[camel];
    if (v === undefined || v === null) continue;
    if (v === "") delete out[camel];
    else out[camel] = v;
  }
  return out;
}

export type GoogleField = "name" | "finalUrl" | "paths" | "headlines" | "descriptions" | "keywords" | "negatives" | "locations" | "phone" | "dailyBudget" | "maxCpc" | "endDate";

/** Qué cambió entre dos versiones (para la línea del hilo y el contexto de @ads). */
export function googleChangedFields(prev: Partial<GoogleProposal>, next: Partial<GoogleProposal>): GoogleField[] {
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const out: GoogleField[] = [];
  if (!same(prev.name, next.name)) out.push("name");
  if (!same(prev.finalUrl, next.finalUrl)) out.push("finalUrl");
  if (!same([prev.path1 ?? "", prev.path2 ?? ""], [next.path1 ?? "", next.path2 ?? ""])) out.push("paths");
  if (!same(prev.headlines, next.headlines)) out.push("headlines");
  if (!same(prev.descriptions, next.descriptions)) out.push("descriptions");
  const kw = (k?: GoogleKeyword[]) => (k ?? []).map((x) => [x.text, x.match]);
  if (!same(kw(prev.keywords), kw(next.keywords))) out.push("keywords");
  if (!same(prev.negatives, next.negatives)) out.push("negatives");
  if (!same([prev.locations, prev.radius], [next.locations, next.radius])) out.push("locations");
  if (!same(prev.phone, next.phone)) out.push("phone");
  if (!same(prev.dailyBudget, next.dailyBudget)) out.push("dailyBudget");
  if (!same(prev.maxCpc, next.maxCpc)) out.push("maxCpc");
  if (!same(prev.endDate, next.endDate)) out.push("endDate");
  return out;
}

const GOOGLE_FIELD_LABEL: Record<GoogleField, string> = {
  name: "el nombre",
  finalUrl: "la página de destino",
  paths: "la ruta visible",
  headlines: "los títulos",
  descriptions: "las descripciones",
  keywords: "las palabras clave",
  negatives: "las negativas",
  locations: "las ubicaciones",
  phone: "el teléfono",
  dailyBudget: "el presupuesto",
  maxCpc: "el tope por clic",
  endDate: "la fecha de fin",
};

/** «los títulos», «los títulos y el presupuesto». Campos que no son de Google se ignoran. */
export function describeGoogleChanges(fields: string[]): string {
  const parts = fields.map((f) => GOOGLE_FIELD_LABEL[f as GoogleField]).filter(Boolean);
  if (!parts.length) return "la propuesta";
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} y ${parts[parts.length - 1]}`;
}

/** La propuesta tal como la espera gs: sin `platform`, sin volúmenes ni el rechazo guardado. */
export function googleForGs(p: StoredGoogleProposal): Omit<GoogleProposal, "platform"> {
  const { platform: _p, policy: _x, ...rest } = p;
  return { ...rest, keywords: rest.keywords.map(({ text, match }) => ({ text, match })) };
}

/** «ghosty.studio/agentes/whatsapp»: la URL visible del anuncio (dominio + rutas). */
export function displayUrl(p: Pick<GoogleProposal, "finalUrl" | "path1" | "path2">): string {
  let host = p.finalUrl;
  try {
    host = new URL(p.finalUrl).hostname.replace(/^www\./, "");
  } catch {
    /* se enseña tal cual */
  }
  return [host, p.path1, p.path2].filter(Boolean).join("/");
}

/** La propuesta en una línea por campo, para el contexto de @ads. */
export function summarizeGoogleProposal(p: GoogleProposal): string {
  return [
    `Google Búsqueda «${p.name}» → ${p.finalUrl}`,
    `${p.headlines.length} títulos: ${p.headlines.map((h) => `«${h}»`).join(", ")}`,
    `${p.descriptions.length} descripciones: ${p.descriptions.map((d) => `«${d}»`).join(", ")}`,
    `palabras clave ${p.keywords.map((k) => (k.match === "exact" ? `[${k.text}]` : `"${k.text}"`)).join(", ")}`,
    `negativas ${p.negatives.join(", ") || "ninguna"}`,
    `ubicaciones ${[...p.locations.map((l) => `${l.name} (${l.id})`), ...(p.radius ? [`radio ${p.radius.km} km de ${p.radius.label}`] : [])].join(", ")}`,
    p.phone ? `teléfono ${p.phone} (mide llamadas)` : "sin teléfono: sin medición de llamadas",
    `presupuesto $${p.dailyBudget} al día${p.maxCpc ? `, tope por clic $${p.maxCpc}` : ""}${p.endDate ? ` hasta ${p.endDate}` : ", sin fecha de fin"}`,
  ].join("; ");
}

/** ¿Es la propuesta de una fila de Google? (la fila guarda `platform`). */
export function isGoogleProposal(p: unknown): p is GoogleProposal {
  return !!p && typeof p === "object" && (p as { platform?: unknown }).platform === "google";
}
