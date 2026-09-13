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
  try {
    // `VerifyDomainDkim` es idempotente: devuelve los mismos tokens si ya se pidió.
    const v = await c.send(new VerifyDomainDkimCommand({ Domain: domain }));
    const tokens = v.DkimTokens ?? [];
    const dns = tokens.map((t) => ({ name: `${t}._domainkey.${domain}`, value: `${t}.dkim.amazonses.com` }));
    const [d, ver] = await Promise.all([
      c.send(new GetIdentityDkimAttributesCommand({ Identities: [domain] })),
      c.send(new GetIdentityVerificationAttributesCommand({ Identities: [domain] })),
    ]);
    const dk = d.DkimAttributes?.[domain]?.DkimVerificationStatus;
    const vs = ver.VerificationAttributes?.[domain]?.VerificationStatus;
    // Con Easy DKIM, el dominio queda verificado cuando los CNAME resuelven: DKIM y la
    // identidad pasan a Success juntos. Con uno solo, todavía no se puede mandar.
    const status: DomainStatus =
      dk === "Success" && vs === "Success" ? "verified"
      : dk === "Failed" || vs === "Failed" ? "failed"
      : "pending";
    return { status, dns };
  } catch (e) {
    return { status: "none", dns: [], error: String(e instanceof Error ? e.message : e).slice(0, 200) };
  }
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
  const nombre = sender?.name || (await getUserName(bySub)) || kit?.name || "quien manda";
  const remitente = sender?.status === "verified" ? sender.effectiveFrom : `${sender?.effectiveFrom ?? "noreply@ghosty.studio"}${sender?.email ? ` (su dominio ${sender.domain} aún no está verificado)` : " (sin dominio propio todavía)"}`;
  return [
    "[CÓMO SALE EL CORREO — lo arma la plataforma, tú NO escribes HTML ni plantillas]",
    `Cada correo = tu texto (párrafos) + cierre + firma + pie legal. Eso ya está hecho.`,
    `Firma: ${nombre}${kit?.name ? `, de ${kit.name}` : ""}${wa ? `, WhatsApp ${wa}` : ""}. Remitente: ${remitente}.`,
    `Cierre: ${describeCta(cta, wa)}. No inventes otro cierre ni pidas dos cosas.`,
    base ? `Mensaje base acordado (lo personalizas por fila):\n«${base}»` : "Todavía no hay mensaje base.",
    "",
    "Tu trabajo con el correo, en orden:",
    "1. Si no hay mensaje base o te piden «el general / la plantilla»: escríbelo como TEXTO (3-4 párrafos,",
    "   sin asunto, sin firma, sin HTML, sin placeholders) y guárdalo con `prospect_message_base`.",
    "   La persona lo ve renderizado en su panel al instante.",
    "2. Para personalizar lead por lead: `prospect_column` con `kind: \"ai\"`, `mode: \"pitch\"` y el",
    "   base como prompt (investiga cada negocio y lo adapta). Empieza con `limit: 3`.",
    "3. Mandar: `prospect_send` abre la revisión; nunca se manda sin que la persona confirme.",
  ].join("\n");
}
