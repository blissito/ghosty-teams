/**
 * El remitente de los correos de prospección.
 *
 * Por defecto todo sale de `SES_FROM` (noreply@ghosty.studio). Un workspace puede poner el
 * SUYO —«Luis de Contadores MX <luis@contadoresmx.com>»— y para eso su dominio tiene que
 * estar verificado en NUESTRA cuenta de SES (Easy DKIM: 3 CNAME en su DNS). Sin esa
 * verificación SES rechaza el envío, así que el `From` propio sólo se usa cuando el dominio
 * ya está en `Success`; mientras tanto se sigue mandando con el de casa y la pantalla lo dice.
 *
 * Las respuestas no pasan por aquí: el prospecto contesta al buzón real del dominio, y
 * ése es del usuario (su Google Workspace, su alias, lo que sea).
 */
import {
  GetIdentityDkimAttributesCommand,
  GetIdentityVerificationAttributesCommand,
  SESClient,
  VerifyDomainDkimCommand,
} from "@aws-sdk/client-ses";
import { getConfigMany, setConfig } from "../../config.server";

const REGION = process.env.SES_REGION || "us-east-1";
const KEY = process.env.SES_KEY;
const SECRET = process.env.SES_SECRET;

let client: SESClient | null = null;
function ses(): SESClient | null {
  if (!KEY || !SECRET) return null;
  client ??= new SESClient({ region: REGION, credentials: { accessKeyId: KEY, secretAccessKey: SECRET } });
  return client;
}

export type DomainStatus = "verified" | "pending" | "failed" | "none";

export type SenderInfo = {
  email: string;
  name: string;
  domain: string | null;
  status: DomainStatus;
  /** Los 3 CNAME de Easy DKIM que hay que poner en el DNS del dominio. */
  dns: { name: string; value: string }[];
  /** Lo que de verdad va en el sobre ahora mismo. */
  effectiveFrom: string;
  error?: string;
};

const DEFAULT_FROM = process.env.SES_FROM || "Ghosty <noreply@ghosty.studio>";

function domainOf(email: string): string | null {
  const m = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/.exec(email.trim().toLowerCase());
  return m ? m[1] : null;
}

function formatFrom(name: string, email: string): string {
  const n = name.trim().replace(/["<>\r\n]/g, "");
  return n ? `${n} <${email}>` : email;
}

async function dkimOf(domain: string): Promise<{ status: DomainStatus; dns: { name: string; value: string }[]; error?: string }> {
  const c = ses();
  if (!c) return { status: "none", dns: [], error: "Correo no configurado en este servidor" };
  const toDns = (tokens: string[]) => tokens.map((t) => ({ name: `${t}._domainkey.${domain}`, value: `${t}.dkim.amazonses.com` }));
  // Se LEE primero. Un dominio ya verificado no necesita que se pida nada, y la lectura es
  // lo único que seguro permite la llave: si `VerifyDomainDkim` no está en su policy, antes
  // esto caía al catch y un dominio en `Success` salía como «sin verificar».
  let dk: { status?: string; tokens: string[] } = { tokens: [] };
  let vs: string | undefined;
  try {
    const [d, ver] = await Promise.all([
      c.send(new GetIdentityDkimAttributesCommand({ Identities: [domain] })),
      c.send(new GetIdentityVerificationAttributesCommand({ Identities: [domain] })),
    ]);
    const a = d.DkimAttributes?.[domain];
    dk = { status: a?.DkimVerificationStatus, tokens: a?.DkimTokens ?? [] };
    vs = ver.VerificationAttributes?.[domain]?.VerificationStatus;
  } catch (e) {
    return { status: "none", dns: [], error: String(e instanceof Error ? e.message : e).slice(0, 200) };
  }
  if (dk.status === "Success" && vs === "Success") return { status: "verified", dns: toDns(dk.tokens) };

  // No está verificado: se piden (o se repiten) los tokens. Es idempotente.
  let tokens = dk.tokens;
  let error: string | undefined;
  if (!tokens.length) {
    try {
      const v = await c.send(new VerifyDomainDkimCommand({ Domain: domain }));
      tokens = v.DkimTokens ?? [];
    } catch (e) {
      error = String(e instanceof Error ? e.message : e).slice(0, 200);
    }
  }
  if (!tokens.length) return { status: "none", dns: [], error: error ?? "SES no devolvió registros" };
  return { status: dk.status === "Failed" || vs === "Failed" ? "failed" : "pending", dns: toDns(tokens), error };
}

export async function getSender(): Promise<SenderInfo> {
  const c = await getConfigMany(["prospeccion_from_email", "prospeccion_from_name"]);
  const email = (c.prospeccion_from_email ?? "").trim();
  const name = (c.prospeccion_from_name ?? "").trim();
  const domain = email ? domainOf(email) : null;
  if (!domain) return { email, name, domain: null, status: "none", dns: [], effectiveFrom: DEFAULT_FROM };
  const d = await dkimOf(domain);
  return {
    email,
    name,
    domain,
    status: d.status,
    dns: d.dns,
    effectiveFrom: d.status === "verified" ? formatFrom(name, email) : DEFAULT_FROM,
    error: d.error,
  };
}

export async function setSender(args: { email: string; name: string }): Promise<SenderInfo | { error: string }> {
  const email = args.email.trim().toLowerCase();
  if (email && !domainOf(email)) return { error: "No parece un correo" };
  await setConfig("prospeccion_from_email", email);
  await setConfig("prospeccion_from_name", args.name.trim().slice(0, 80));
  return getSender();
}

/** El `From` que va en el sobre HOY. Barato de llamar: sólo pega a SES si hay dominio propio. */
export async function effectiveFrom(): Promise<{ from: string; own: boolean }> {
  const s = await getSender();
  return { from: s.effectiveFrom, own: s.status === "verified" };
}

// ── El cierre del correo (CTA) ───────────────────────────────────────────────────────────
//
// Un correo de prospección pide UNA cosa. Se decide por workspace, igual que el WhatsApp:
// `wa` (botón a tu WhatsApp), `reply` (una frase que invita a contestar) o `link` (una URL
// tuya: agenda, landing, formulario). El agente lo sabe al redactar para no inventar otro.
export type CtaKind = "wa" | "reply" | "link";
export type CtaConfig = { kind: CtaKind; label: string; url: string };

const CTA_DEFAULT_LABEL: Record<CtaKind, string> = {
  wa: "Escríbenos por WhatsApp",
  reply: "Si te interesa, responde a este correo y te cuento más.",
  link: "Agenda una llamada",
};

export async function getCta(): Promise<CtaConfig> {
  const c = await getConfigMany(["prospeccion_cta_kind", "prospeccion_cta_label", "prospeccion_cta_url"]);
  const kind = (["wa", "reply", "link"].includes(c.prospeccion_cta_kind ?? "") ? c.prospeccion_cta_kind : "wa") as CtaKind;
  return {
    kind,
    label: (c.prospeccion_cta_label ?? "").trim() || CTA_DEFAULT_LABEL[kind],
    url: (c.prospeccion_cta_url ?? "").trim(),
  };
}

export async function setCta(args: { kind: CtaKind; label: string; url: string }): Promise<CtaConfig | { error: string }> {
  const url = args.url.trim();
  if (args.kind === "link" && !/^https?:\/\/\S+$/.test(url)) return { error: "Pon un enlace completo, con https://" };
  await setConfig("prospeccion_cta_kind", args.kind);
  await setConfig("prospeccion_cta_label", args.label.trim().slice(0, 80));
  await setConfig("prospeccion_cta_url", args.kind === "link" ? url : "");
  return getCta();
}

/** Cómo se le describe el cierre al agente que redacta, para que no invente otro. */
export function describeCta(c: CtaConfig, waPhone: string | null): string {
  if (c.kind === "wa") return waPhone ? `un botón «${c.label}» a WhatsApp` : "un botón a WhatsApp (todavía sin número configurado)";
  if (c.kind === "link") return `un botón «${c.label}» que abre ${c.url}`;
  return `la frase «${c.label}»`;
}

// ── El mensaje BASE ──────────────────────────────────────────────────────────────────────
//
// «Primero el general, luego lead por lead»: el usuario y el agente acuerdan un texto base
// (qué ofrecemos, tono, estructura) y la columna `pitch` lo personaliza fila por fila con lo
// que investiga. Es texto plano con párrafos, NO HTML: la plantilla (firma, cierre, pie) es
// de la plataforma y el agente no la arma.
export async function getMessageBase(): Promise<string> {
  const c = await getConfigMany(["prospeccion_message_base"]);
  return (c.prospeccion_message_base ?? "").trim();
}

export async function setMessageBase(text: string): Promise<string> {
  const clean = text.replace(/<[^>]+>/g, "").replace(/\r/g, "").trim().slice(0, 4000);
  await setConfig("prospeccion_message_base", clean);
  return clean;
}

/**
 * Lo que el agente tiene que saber del correo ANTES de proponer nada. Va en el contexto
 * del panel y en el prompt de cada columna escrita. Sin esto armaba su propio HTML con
 * placeholders y preguntaba quién firma.
 */
export async function outreachBrief(bySub: string | null): Promise<string> {
  const { getUserName } = await import("./send.server");
  const { getConfig } = await import("../../config.server");
  const { activeBrandKit } = await import("../brand.server");
  const [sender, cta, wa, kit, base] = await Promise.all([
    getSender().catch(() => null),
    getCta(),
    getConfig("prospeccion_wa_phone"),
    activeBrandKit().catch(() => null),
    getMessageBase(),
  ]);
  const empresa = (await getSignatureBusiness()) || kit?.name || null;
  const nombre = sender?.name || (await getUserName(bySub)) || empresa || "quien manda";
  const remitente = sender?.status === "verified" ? sender.effectiveFrom : `${sender?.effectiveFrom ?? "noreply@ghosty.studio"}${sender?.email ? ` (su dominio ${sender.domain} aún no está verificado)` : " (sin dominio propio todavía)"}`;
  return [
    "[CÓMO SALE EL CORREO — lo arma la plataforma, tú NO escribes HTML ni plantillas]",
    `Cada correo = tu texto (párrafos) + cierre + firma + pie legal. Eso ya está hecho.`,
    `Firma: ${nombre}${empresa ? `, de ${empresa}` : ""}${wa ? `, WhatsApp ${wa}` : ""}. Remitente: ${remitente}.`,
    `Membrete y firma: ${(await getSignatureExtras()).logoUrl ? "logo propio" : kit?.logoUrl ? "logo de la marca activa" : "sin logo"}${(await getSignatureExtras()).website ? `, sitio ${(await getSignatureExtras()).website}` : ", sin sitio web"}${(await getSignatureExtras()).title ? `, cargo «${(await getSignatureExtras()).title}»` : ""}. Se cambian con \`title\`, \`website\` y \`logoUrl\` (URL https directa a un png/svg) en \`prospect_outreach_setup\`. El sitio va SÓLO en \`website\` (se pinta como membrete y bajo el cierre): no lo repitas en tagline, business ni name. El cargo va en \`title\`, no dentro de \`name\`.`,
    `Pie del correo: «Te escribe ${nombre}${empresa ? ` de ${empresa}` : ""}${(await getSignatureTagline()) ? `, ${await getSignatureTagline()}` : ""}. Si no esperabas este correo, puedes ignorarlo.» La frase de ignorar es fija (es lo honesto en un correo frío); lo que dice de la empresa se cambia con \`tagline\` en \`prospect_outreach_setup\`.`,
    "Si te piden cambiar la firma, la empresa, el remitente, el cierre o el WhatsApp: hazlo con `prospect_outreach_setup`, no lo pidas por chat.",
    "CÓMO SE LLAMAN estas tools (`prospect_*`): son tools nativas de Teams. En code-mode: `const { run } = await import('/opt/gs-sdk/connectors.mjs'); await run('prospect_outreach_setup', { name: 'Héctor', business: 'Normi' })` — no hace falta que aparezcan en tu lista de tools, `run` las ejecuta por nombre. Si tienes tools MCP, es la del mismo nombre. Sólo si la llamada devuelve error, repórtalo tal cual; nunca digas que lo hiciste sin haberla llamado.",
    `Cierre: ${describeCta(cta, wa)}. No inventes otro cierre ni pidas dos cosas.`,
    base ? `Mensaje base acordado (lo personalizas por fila):\n«${base}»` : "Todavía no hay mensaje base.",
    "",
    "Tu trabajo con el correo, en orden:",
    "1. Si no hay mensaje base o te piden «el general / la plantilla»: escríbelo como TEXTO (3-4 párrafos,",
    "   sin asunto, sin firma, sin HTML, sin placeholders) y guárdalo: `run('prospect_message_base', { text })`.",
    "   La persona lo ve renderizado en su panel al instante.",
    "2. Para personalizar lead por lead: `prospect_column` con `kind: \"ai\"`, `mode: \"pitch\"` y el",
    "   base como prompt (investiga cada negocio y lo adapta). Empieza con `limit: 3`.",
    "3. Mandar: `prospect_send` abre la revisión; nunca se manda sin que la persona confirme.",
  ].join("\n");
}

/**
 * La EMPRESA de la firma, si no es la marca activa del workspace.
 *
 * Un workspace prospecta a veces para otra marca (una agencia, un producto nuevo). Con esto
 * la firma dice esa empresa y NO pinta el logo de la marca activa, que sería de otra.
 */
/** Una línea de qué hace la empresa: va bajo la firma y en el pie. */
export async function getSignatureTagline(): Promise<string> {
  const c = await getConfigMany(["prospeccion_signature_tagline"]);
  return (c.prospeccion_signature_tagline ?? "").trim();
}

/** Cargo, sitio y logo propios de la firma. Vacíos = no se pintan (o el logo de la marca). */
export async function getSignatureExtras(): Promise<{ title: string; website: string; logoUrl: string }> {
  const c = await getConfigMany(["prospeccion_signature_title", "prospeccion_signature_website", "prospeccion_signature_logo"]);
  return {
    title: (c.prospeccion_signature_title ?? "").trim(),
    website: (c.prospeccion_signature_website ?? "").trim(),
    logoUrl: (c.prospeccion_signature_logo ?? "").trim(),
  };
}

export async function getSignatureBusiness(): Promise<string> {
  const c = await getConfigMany(["prospeccion_signature_business"]);
  return (c.prospeccion_signature_business ?? "").trim();
}

/** Todo lo del remitente en una llamada, para el agente: lo que venga vacío no se toca. */
/** Sin URLs ni saltos: el sitio va en `website`, y en la firma cada cosa va en su campo. */
function plain(v: string): string {
  return v.replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").replace(/^[\s,·—-]+|[\s,·—-]+$/g, "").trim();
}

export async function setupOutreach(args: {
  name?: string;
  business?: string;
  /** Qué hace la empresa, en una línea. Va bajo la firma y en el pie. */
  tagline?: string;
  /** Cargo de quien firma («Founder», «Directora comercial»). */
  title?: string;
  /** Sitio web: membrete, enlace bajo el cierre y firma. */
  website?: string;
  /** URL pública de un logo (png/svg/jpg). Sustituye al de la marca activa. */
  logoUrl?: string;
  email?: string;
  ctaKind?: CtaKind;
  ctaLabel?: string;
  ctaUrl?: string;
  waPhone?: string;
}): Promise<{ ok: true; resumen: string } | { ok: false; error: string }> {
  if (args.name !== undefined || args.email !== undefined) {
    const cur = await getConfigMany(["prospeccion_from_email", "prospeccion_from_name"]);
    const r = await setSender({
      email: args.email ?? cur.prospeccion_from_email ?? "",
      name: args.name !== undefined ? plain(args.name) : (cur.prospeccion_from_name ?? ""),
    });
    if ("error" in r && typeof r.error === "string") return { ok: false, error: r.error };
  }
  if (args.business !== undefined) await setConfig("prospeccion_signature_business", plain(args.business).slice(0, 80));
  if (args.tagline !== undefined) await setConfig("prospeccion_signature_tagline", plain(args.tagline).slice(0, 140));
  if (args.title !== undefined) await setConfig("prospeccion_signature_title", plain(args.title).slice(0, 60));
  if (args.website !== undefined) {
    const w = args.website.trim();
    if (w && !/^https?:\/\/\S+$/.test(w)) return { ok: false, error: "El sitio va completo, con https://" };
    await setConfig("prospeccion_signature_website", w.slice(0, 200));
  }
  if (args.logoUrl !== undefined) {
    const l = args.logoUrl.trim();
    if (l && !/^https:\/\/\S+\.(png|jpe?g|svg|webp)(\?\S*)?$/i.test(l)) return { ok: false, error: "El logo tiene que ser una URL https a un png/jpg/svg/webp" };
    await setConfig("prospeccion_signature_logo", l.slice(0, 300));
  }
  if (args.ctaKind || args.ctaLabel !== undefined || args.ctaUrl !== undefined) {
    const cur = await getCta();
    const r = await setCta({
      kind: args.ctaKind ?? cur.kind,
      label: args.ctaLabel ?? (args.ctaKind && args.ctaKind !== cur.kind ? "" : cur.label),
      url: args.ctaUrl ?? cur.url,
    });
    if ("error" in r) return { ok: false, error: r.error };
  }
  if (args.waPhone !== undefined) {
    const { normalizeWaPhone } = await import("../../lib/prospeccion-wa-phone");
    const n = normalizeWaPhone(args.waPhone);
    if (args.waPhone.trim() && !n) return { ok: false, error: "No parece un número de WhatsApp" };
    await setConfig("prospeccion_wa_phone", n ?? "");
  }
  return { ok: true, resumen: await outreachBrief(null) };
}
