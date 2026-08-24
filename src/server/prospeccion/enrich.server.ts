/**
 * Enriquecimiento por COLUMNA — el motor tipo Clay.
 *
 * La unidad de trabajo es la columna, no la fila: el usuario dice "agrégame ¿tiene sitio
 * web?" y eso corre sobre las N filas. Cada enriquecedor es una función pequeña detrás de
 * un registro, así que agregar uno nuevo no toca el motor.
 *
 * Dos ideas de Clay que sí valen la pena copiar:
 *  · **Cascada**: se intentan varias fuentes en orden y gana la primera que resuelve. Un
 *    correo puede salir del sitio, de una redactado social o de un proveedor de pago; la columna
 *    declara el orden y el motor lo recorre.
 *  · **Verificado**: la celda guarda si el dato se confirmó o se dedujo. Es lo que después
 *    permite cobrar sólo lo que sirve — en México cobrar el intento fallido se castiga.
 */
import { dbqMany } from "../../dbq.server";
import { addColumn, listRows, setCell, type ProspRow, type Recipe } from "./lists.server";
import { matches, type Filter } from "../../lib/prospeccion-filter";

/**
 * Lo que devuelve un enriquecedor.
 *
 * `extra` son OTRAS celdas de la misma pasada, y es la parte que cambia la economía del
 * módulo. Antes esto era un solo string: «Correo del sitio» descargaba hasta cuatro
 * páginas del negocio, sacaba una dirección de correo y TIRABA el resto del HTML. Sacar
 * además el Instagram del pie de página costaba volver a descargarlo todo.
 *
 * Con `extra`, una sola pasada de red rinde correo, WhatsApp, redes y teléfono. El costo
 * de red es idéntico; lo que cambia es cuánto se aprovecha.
 *
 * ⚠️ Las llaves de `extra` son llaves de CELDA. Si nadie registra su columna, el dato se
 * guarda y no se ve — el mismo agujero que tenía el tamaño de empresa. Por eso
 * `runColumn` registra la columna de cada celda extra que de verdad se llenó.
 */
export type EnrichResult = {
  v: string | null;
  verified: boolean;
  extra?: Record<string, { v: string | null; verified?: boolean }>;
};

export type Enricher = {
  id: string;
  label: string;
  /**
   * Qué le falta a la fila para poder correr, EN PALABRAS.
   *
   * ⚠️ Cuando `needs()` dice que no, la fila se salta en silencio. Si se salta a TODAS, la
   * persona ve una columna vacía y ninguna explicación — que es exactamente lo que pasó con
   * «¿El correo sirve?» sobre una lista cuyos correos vivían en una columna propia
   * («Correo de contacto») y no en la columna base Correo. Sin esta frase, un enriquecedor
   * que no puede trabajar es indistinguible de uno roto.
   */
  requires: string;
  /**
   * POR QUÉ esta fila no se pudo intentar, en palabras.
   *
   * ⚠️ Una sola frase para todos los saltos MIENTE cuando los motivos son opuestos. Pasó
   * con «Correo del sitio»: decía «les falta un valor en Sitio web, y la columna Correo
   * vacía» — pero a las filas que ya tenían correo no les FALTA nada, es que ya lo tienen.
   * Juntar «no puede» con «no hace falta» en una frase deja al usuario buscando un problema
   * que no existe.
   */
  whyNot: (row: ProspRow) => string | null;
  /**
   * Si el dato ES una columna base, se escribe ahí directo.
   *
   * Sin esto, un enriquecedor de correos creaba una columna aparte y hacía falta una acción
   * de «pasar estos valores a la columna Correo» — que es una idea del modelo interno, no
   * del trabajo: quien busca el correo de un negocio quiere el correo del negocio, no una
   * segunda columna de correos que además hay que promover a mano.
   */
  writesTo?: "name" | "phone" | "email" | "website" | "address" | "category";
  /** Qué necesita de la fila para poder correr. Sin esto se salta sin gastar redactado. */
  needs: (row: ProspRow) => boolean;
  /**
   * Las celdas extra que puede emitir, con su etiqueta. Mismo contrato que el de una
   * fuente: se declaran aquí y sólo se registran las que de verdad se llenaron.
   */
  extraColumns?: { key: string; label: string }[];
  run: (row: ProspRow) => Promise<EnrichResult>;
};

const UA = "Mozilla/5.0 (compatible; GhostyProspeccion/1.0; +https://ghosty.studio)";
const TIMEOUT = 12_000;

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) return null;
    const tipo = res.headers.get("content-type") ?? "";
    if (!tipo.includes("html") && !tipo.includes("text")) return null;
    // Tope de 400KB: una homeHtml normal no pasa de 150KB y no hay razón para leer un blob.
    const buf = await res.arrayBuffer();
    return new TextDecoder("utf-8").decode(buf.slice(0, 400_000));
  } catch {
    return null;
  }
}

/** Correos de plataforma que aparecen en cualquier sitio y no son del negocio. */
const JUNK_EMAIL = /@(sentry|wixpress|example|sentry\.io|godaddy|wordpress|squarespace|shopify|schema|w3\.org|googleapis)/i;
const ASSET_EXT = /\.(png|jpe?g|gif|webp|svg|css|js)$/i;

function emailsIn(html: string): string[] {
  const seen = new Set<string>();
  // `mailto:` primero: es una declaración explícita, no una coincidencia de text.
  for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) {
    const e = decodeURIComponent(m[1]).toLowerCase().trim();
    if (e.includes("@") && !JUNK_EMAIL.test(e) && !ASSET_EXT.test(e)) seen.add(e);
  }
  for (const m of html.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]{2,}/g)) {
    const e = m[0].toLowerCase();
    if (!JUNK_EMAIL.test(e) && !ASSET_EXT.test(e)) seen.add(e);
  }
  return [...seen];
}

/**
 * Ordena los correos por qué tan probable es que sean del negocio.
 *
 * `contacto@` y `ventas@` ganan a `soporte@`, y cualquiera gana a un gmail suelto que suele
 * ser de quien hizo la página. No es exacto y no pretende serlo: la columna se puede
 * corregir a mano, que es justo para lo que la rejilla es editable.
 */
function bestEmail(emails: string[], domain: string | null): string | null {
  if (!emails.length) return null;
  const score = (e: string): number => {
    let p = 0;
    const [mailbox, host] = e.split("@");
    if (domain && host?.endsWith(domain)) p += 10;
    if (/^(contacto|ventas|hola|info|comercial|citas|reservas)/.test(mailbox)) p += 5;
    if (/^(no-?reply|postmaster|abuse|webmaster|admin|soporte)/.test(mailbox)) p -= 6;
    if (/(gmail|hotmail|outlook|yahoo)\./.test(host ?? "")) p -= 2;
    return p;
  };
  return [...emails].sort((a, b) => score(b) - score(a))[0];
}

function domainOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}


/**
 * Perfiles sociales del negocio, sacados de los enlaces de la propia página.
 *
 * Casi toda pyme mexicana pone sus redes en el pie. Para muchos negocios sin correo, ESE
 * es el canal de contacto que sí existe, y estaba tirándose junto con el resto del HTML.
 *
 * ⚠️ Se filtran las rutas de COMPARTIR (`sharer`, `intent/tweet`, `/share`): un botón de
 * "compartir en Facebook" enlaza a facebook.com y no es el perfil de nadie. Sin ese
 * filtro, la columna se llena de basura que además parece correcta.
 */
const SOCIAL: { key: string; label: string; re: RegExp }[] = [
  { key: "instagram", label: "Instagram", re: /https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9_.]{2,30})/i },
  { key: "facebook", label: "Facebook", re: /https?:\/\/(?:www\.|m\.)?facebook\.com\/([A-Za-z0-9_.-]{3,60})/i },
  { key: "linkedin", label: "LinkedIn", re: /https?:\/\/(?:[a-z]{2}\.)?linkedin\.com\/(?:company|in)\/([A-Za-z0-9_%-]{2,60})/i },
  { key: "tiktok", label: "TikTok", re: /https?:\/\/(?:www\.)?tiktok\.com\/@([A-Za-z0-9_.]{2,30})/i },
];

const SHARE_PATH = /(sharer|share\.php|\/share|intent\/|plugins\/|\/tr\?|dialog\/)/i;
/** Rutas de la propia plataforma que no son el perfil de un negocio. */
const SOCIAL_JUNK = /^(profile\.php|pages|sharer|home|login|help|policies|privacy|tr|events|groups|watch|search|hashtag|explore|reel|p|about)$/i;

export function socialsIn(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of SOCIAL) {
    for (const m of html.matchAll(new RegExp(s.re.source, "gi"))) {
      if (SHARE_PATH.test(m[0]) || SOCIAL_JUNK.test(m[1])) continue;
      out[s.key] = m[0].replace(/[)"'<].*$/, "");
      break;
    }
  }
  return out;
}

/**
 * El WhatsApp del negocio.
 *
 * Es la celda más valiosa del módulo y no existía: TODO el envío cierra por WhatsApp
 * (`send.server.ts` arma ligas `wa.me`) y no había ninguna columna que dijera si el
 * prospecto tiene ese canal. Un `wa.me` en el sitio es una declaración explícita —el
 * negocio publicó ese número para que le escriban— y vale más que un teléfono de
 * directorio, que puede ser un conmutador.
 *
 * Se guarda el NÚMERO, no la liga: es lo que se puede comparar contra el teléfono, contra
 * la bitácora de tocadas y contra un mensaje entrante.
 */
export function whatsappIn(html: string): string | null {
  const pats = [
    /(?:wa\.me|api\.whatsapp\.com\/send\?phone=|web\.whatsapp\.com\/send\?phone=)\/?(\+?\d[\d\s()-]{8,20})/i,
    /whatsapp[^<>{}]{0,40}?(\+?52[\s-]?\d[\d\s()-]{8,16})/i,
  ];
  for (const re of pats) {
    const d = (html.match(re)?.[1] ?? "").replace(/\D/g, "");
    // 10 dígitos nacionales o 12-13 con lada de país. Menos es un id de plugin, no un número.
    if (d.length >= 10 && d.length <= 13) return d.slice(-10).replace(/(\d{2})(\d{4})(\d{4})/, "$1 $2 $3");
  }
  return null;
}

/**
 * Datos estructurados de la propia página (`schema.org`, casi siempre `LocalBusiness`).
 *
 * Es la mejor fuente de la página y la más barata de leer: el negocio la publicó A
 * PROPÓSITO para que la lean las máquinas, así que no hay que adivinar nada. La trae una
 * fracción grande de los sitios hechos con plantilla, que en pyme son la mayoría.
 *
 * ⚠️ Se recorre el árbol completo (`@graph`, arrays anidados) porque casi ningún sitio lo
 * emite plano. Y va en `try`: un JSON-LD mal formado es común y no puede tumbar la pasada.
 */
export function jsonLd(html: string): { phone?: string; email?: string; name?: string } {
  const out: { phone?: string; email?: string; name?: string } = {};
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (n: unknown): void => {
        if (Array.isArray(n)) return n.forEach(walk);
        if (!n || typeof n !== "object") return;
        const o = n as Record<string, unknown>;
        if (!out.phone && typeof o.telephone === "string") out.phone = o.telephone;
        if (!out.email && typeof o.email === "string") out.email = o.email;
        if (!out.name && typeof o.name === "string") out.name = o.name;
        Object.values(o).forEach(walk);
      };
      walk(JSON.parse(m[1].trim()));
    } catch {
      // JSON-LD roto es normalísimo. Se ignora esa etiqueta y se sigue con las demás.
    }
  }
  return out;
}

/** Teléfonos declarados con `tel:`. Sólo los explícitos: un regex suelto caza precios y folios. */
export function phoneIn(html: string): string | null {
  for (const m of html.matchAll(/tel:(\+?[\d\s().-]{9,20})/gi)) {
    const d = m[1].replace(/\D/g, "");
    if (d.length >= 10 && d.length <= 13) return d.slice(-10).replace(/(\d{2})(\d{4})(\d{4})/, "$1 $2 $3");
  }
  return null;
}

/**
 * ¿Hay formulario de contacto?
 *
 * Importa cuando NO hay correo: es la diferencia entre "no hay por dónde" y "sí hay, pero
 * a mano". Sin esta señal, esas filas se ven idénticas a las inalcanzables y se descartan.
 */
export function hasContactForm(html: string): boolean {
  return /<form[^>]*>[\s\S]{0,4000}?<\/form>/i.test(html) &&
    /(name|id|placeholder|type)\s*=\s*["'][^"']*(mail|mensaje|message|contacto|nombre)/i.test(html);
}

/**
 * Los enriquecedores que existen hoy.
 *
 * Deliberadamente pocos y todos gratis: cada uno que necesite un proveedor de pago hay que
 * costearlo POR FILA antes de fijarle precio, y eso es una decisión aparte.
 */
export const ENRICHERS: Record<string, Enricher> = {
  /** ¿El sitio existe y responde? Es el filtro de calidad más barato que hay. */
  sitio_vivo: {
    id: "sitio_vivo",
    label: "¿El sitio funciona?",
    requires: "un valor en la columna Sitio web",
    whyNot: (r) => (!r.website ? "sin sitio web" : null),
    needs: (r) => !!r.website,
    async run(r) {
      const html = await fetchText(r.website!);
      return { v: html ? "sí" : "no", verified: true };
    },
  },

  /**
   * El correo, sacado del sitio del negocio.
   *
   * Es EL enriquecedor que desbloquea el loop: DENUE casi nunca trae correo, y sin correo
   * no hay paso "abrir". Mira la homeHtml y, si no encuentra, una página de contacto.
   */
  correo_del_sitio: {
    id: "correo_del_sitio",
    // La etiqueta ya no dice «correo»: devuelve el correo Y todo lo demás que la página
    // publica. Llamarla «Correo del sitio» escondía cinco columnas.
    label: "Contacto del sitio",
    requires: "un valor en la columna Sitio web",
    // ⚠️ Ya no se salta a quien YA tiene correo: la pasada sigue valiendo por el WhatsApp,
    // las redes y el teléfono. Antes tener correo cancelaba todo lo demás.
    whyNot: (r) => (!r.website ? "sin sitio web" : null),
    writesTo: "email",
    needs: (r) => !!r.website,
    extraColumns: [
      { key: "whatsapp", label: "WhatsApp" },
      { key: "instagram", label: "Instagram" },
      { key: "facebook", label: "Facebook" },
      { key: "linkedin", label: "LinkedIn" },
      { key: "tiktok", label: "TikTok" },
      { key: "tel_sitio", label: "Tel. del sitio" },
      { key: "tipo_correo", label: "Tipo de correo" },
      { key: "formulario", label: "¿Tiene formulario?" },
    ],
    async run(r) {
      const domain = domainOf(r.website);
      const base = r.website!.replace(/\/$/, "");
      const extra: NonNullable<EnrichResult["extra"]> = {};
      let email: string | null = null;
      let form = false;

      /** Exprime UNA página. Todo lo que encuentre se queda, aunque el correo ya esté. */
      const mine = (html: string): void => {
        const ld = jsonLd(html);
        if (!email) email = bestEmail(emailsIn(html), domain) ?? (ld.email?.includes("@") ? ld.email.toLowerCase() : null);
        if (!extra.whatsapp?.v) {
          const wa = whatsappIn(html);
          if (wa) extra.whatsapp = { v: wa, verified: true };
        }
        for (const [k, v] of Object.entries(socialsIn(html))) {
          if (!extra[k]?.v) extra[k] = { v, verified: true };
        }
        if (!extra.tel_sitio?.v) {
          // El `tel:` de la página gana al `telephone` del JSON-LD: es el que está puesto
          // para que le marquen desde el celular.
          const tel = phoneIn(html) ?? (ld.phone ? phoneIn(`tel:${ld.phone}`) : null);
          if (tel && tel !== r.phone) extra.tel_sitio = { v: tel, verified: true };
        }
        if (!form) form = hasContactForm(html);
      };

      const home = await fetchText(r.website!);
      if (home) mine(home);

      /**
       * Segunda pasada por las rutas de contacto habituales.
       *
       * ⚠️ Sólo si falta ALGO de lo caro (correo o WhatsApp). Cuando la portada ya los dio,
       * pedir tres páginas más es gastar red y paciencia del sitio ajeno para nada.
       */
      if (!email || !extra.whatsapp?.v) {
        for (const path of ["/contacto", "/contactanos", "/contact", "/nosotros"]) {
          const p = await fetchText(`${base}${path}`);
          if (!p) continue;
          mine(p);
          if (email && extra.whatsapp?.v) break;
        }
      }

      /**
       * Nominal (`juan.perez@`) vs genérico (`info@`).
       *
       * El scoring que lo distingue ya se calculaba dentro de `bestEmail` para elegir, y se
       * tiraba después. Escribirlo cuesta cero y es una señal de conversión real: a una
       * persona con nombre se le escribe distinto que a un buzón de la empresa.
       */
      if (email) {
        const mailbox = String(email).split("@")[0];
        const generico = /^(contacto|ventas|hola|info|comercial|citas|reservas|admin|soporte|atencion|no-?reply)/i.test(mailbox);
        extra.tipo_correo = { v: generico ? "genérico" : "nominal", verified: true };
      }
      // El formulario sólo se anota cuando NO hay correo: ahí es donde cambia la decisión.
      // Con correo en mano es ruido, y una columna de ruido se deja de mirar.
      if (!email) extra.formulario = { v: form ? "sí" : "no", verified: true };

      // `verified` mira el correo, que es lo que va a la columna base. Que se haya
      // encontrado un Instagram no hace verificado un correo que no apareció.
      return { v: email, verified: !!email, extra };
    },
  },

  /**
   * ¿El correo que tenemos sirve?
   *
   * ⚠️ Es lo que hay que correr ANTES de la primera tanda. Una lista scrapeada trae 20-40%
   * de direcciones muertas, y mandarle a eso desde un dominio recién calentado lo quema de
   * una sola vez: el dominio tarda semanas en calentarse y minutos en arruinarse.
   *
   * No cuesta nada — sintaxis, lista de desechables y UNA consulta DNS por dominio (con
   * caché, y en una lista cientos de filas comparten dominio).
   */
  correo_sirve: {
    id: "correo_sirve",
    label: "¿El correo sirve?",
    requires: "un valor en la columna Correo",
    whyNot: (r) => (!r.email ? "sin correo que comprobar" : null),
    needs: (r) => !!r.email,
    async run(r) {
      const { verifyEmail, verdictLabel } = await import("./verify-email.server");
      const v = await verifyEmail(r.email!);
      // `verified` sólo cuando de verdad se comprobó algo contra el mundo (el MX): un
      // «mal escrito» se sabe sin salir a la red.
      return { v: verdictLabel(v.verdict), verified: v.verdict !== "sintaxis" };
    },
  },

};

/**
 * ⚠️ El ORDEN de esta lista es el orden en que se ofrecen, y lo dicta el LOOP.
 *
 * «¿El correo sirve?» va PRIMERO porque su propia descripción dice «córrelo siempre antes
 * de la primera tanda» — tenerla en tercer lugar contradecía su propio texto. Sin correo
 * vivo no hay nada que abrir, y mandar a una lista sin verificar quema el dominio.
 *
 * Y ya NO está «¿Tiene sitio?»: contestaba exactamente lo mismo que el filtro «sin Sitio
 * web», que es instantáneo y no ocupa una columna. Crear una columna, correrla sobre once
 * mil filas y gastar ancho de pantalla para saber algo que un chip contesta al momento era
 * duplicar una capacidad que ya existía.
 */
const ORDEN = ["correo_sirve", "correo_del_sitio", "sitio_vivo"];

export function listEnrichers() {
  return ORDEN.map((id) => ENRICHERS[id])
    .filter(Boolean)
    .map((e) => ({ id: e.id, label: e.label, writesTo: e.writesTo ?? null, requires: e.requires }));
}

/** A qué columna base escribe una cascada, si alguno de sus pasos lo declara. */
export function waterfallWritesTo(ids: string[]): string | null {
  for (const id of ids) {
    const w = ENRICHERS[id]?.writesTo;
    if (w) return w;
  }
  return null;
}

export type RunProgress = { done: number; total: number; filled: number };

/** El resultado con su explicación, para que una columna vacía nunca sea un misterio. */
export type RunOutcome = RunProgress & { skipped: number; note: string | null };

/**
 * Corre una columna sobre toda la lista.
 *
 * Concurrencia limitada a propósito: son peticiones a sitios de terceros, y disparar 100 a
 * la vez es indistinguible de un ataque from el otro lado. Cuatro a la vez tarda poco y no
 * se gana enemigos.
 *
 * ⚠️ Nunca pisa una celda escrita A MANO. Alguien que corrigió un correo no quiere que la
 * siguiente pasada se lo borre, y sin esta regla el trabajo humano se pierde en silencio.
 */
export async function runColumn(args: {
  listId: number;
  key: string;
  recipe: Recipe | null;
  /**
   * ⚠️ La VISTA, no la lista. Enriquecer sobre las 10,728 cuando la persona está mirando
   * 312 es hacer algo distinto de lo que pidió — y en las que cuestan red o tokens, es
   * gastar de más sin avisar.
   */
  filter?: Filter;
  fields?: string[];
  /**
   * Correr sólo sobre las primeras N de la vista.
   *
   * Existe porque «pruébalo con 10 a ver qué sale» es el primer movimiento de cualquiera
   * ante una lista de 295, y no se puede expresar como filtro. El agente lo daba por hecho
   * y decía haberlo hecho sin poder — el 2026-08-23 anunció «lo lancé sobre las primeras
   * 10» con la herramienta corriendo sobre las 295.
   */
  limit?: number;
  onProgress?: (p: RunProgress) => void;
  concurrency?: number;
}): Promise<RunOutcome> {
  const todas = await listRows(args.listId);
  const filtradas = args.filter?.length
    ? todas.filter((r) => matches(r as unknown as Record<string, unknown>, args.filter!, args.fields ?? []))
    : todas;
  const rows = args.limit && args.limit > 0 ? filtradas.slice(0, args.limit) : filtradas;
  const waterfall_ = (args.recipe?.waterfall ?? []).map((id) => ENRICHERS[id]).filter(Boolean);
  const total = rows.length;
  let done = 0;
  let filled = 0;
  /** Filas que ningún paso pudo ni intentar, agrupadas por POR QUÉ. */
  let skipped = 0;
  /** Llaves extra que de verdad se llenaron: sólo ésas se convierten en columna. */
  const extraLlenas = new Set<string>();
  const motivos = new Map<string, number>();

  if (!waterfall_.length) return { done: 0, total, filled: 0, skipped: 0, note: "esta columna no tiene de dónde sacar el dato" };

  const queue = [...rows];
  const workers = Array.from({ length: Math.min(args.concurrency ?? 4, 8) }, async () => {
    for (;;) {
      const row = queue.shift();
      if (!row) return;

      // Si la cascada declara columna base (un buscador de correos escribe en Correo), el
      // valor va AHÍ. `args.key` sólo se usa cuando el dato no cabe en ningún campo fijo.
      const destino = waterfallWritesTo(args.recipe?.waterfall ?? []) ?? args.key;

      const ya = row.data[args.key];
      // Nunca pisa lo escrito A MANO: alguien que corrigió un dato no quiere que la
      // siguiente pasada se lo borre.
      if (ya?.src === "manual" && ya.v) { done++; args.onProgress?.({ done, total, filled }); continue; }

      let res: EnrichResult = { v: null, verified: false };
      let fuente = "";
      let intentado = false;
      for (const e of waterfall_) {
        if (!e.needs(row)) continue;
        intentado = true;
        try {
          res = await e.run(row);
        } catch {
          res = { v: null, verified: false };
        }
        if (res.v) { fuente = e.id; break; }
      }

      if (!intentado) {
        // El motivo del PRIMER paso que la rechazó: es el que explica el salto.
        const porQue = waterfall_.map((e) => e.whyNot(row)).find(Boolean) ?? "no aplicaba";
        motivos.set(porQue, (motivos.get(porQue) ?? 0) + 1);
        // ⚠️ Una fila que NO se pudo intentar se deja INTACTA. Antes se le escribía igual
        // (null, `sin_fuente`) y eso BORRABA lo que ya tuviera: volver a correr una columna
        // vaciaba las filas que no calificaban. Cazado por el smoke, no en producción.
        skipped++;
        done++;
        args.onProgress?.({ done, total, filled });
        continue;
      }

      await setCell(row.id, destino, res.v, { src: fuente || "sin_fuente", verified: res.verified });

      /**
       * Las celdas extra de la misma pasada.
       *
       * ⚠️ NUNCA pisan una celda que ya tiene valor, y por la misma razón que la principal:
       * la cascada corre varias veces sobre la misma lista y el segundo intento no puede
       * borrar lo que el primero encontró. Aquí importa más todavía — el WhatsApp puede
       * haberlo escrito una persona a mano.
       */
      for (const [k, cell] of Object.entries(res.extra ?? {})) {
        if (!cell?.v) continue;
        if (row.data[k]?.v) continue;
        await setCell(row.id, k, cell.v, { src: fuente || "sin_fuente", verified: cell.verified ?? false });
        extraLlenas.add(k);
      }

      if (res.v) filled++;
      done++;
      args.onProgress?.({ done, total, filled });
    }
  });

  await Promise.all(workers);

  /**
   * Registra la columna de cada celda extra que se llenó.
   *
   * ⚠️ Sin esto el dato se guarda y NO SE VE — la rejilla pinta `gt_prosp_columns`, y una
   * llave suelta en `data_json` no la enseña nadie. Es el mismo agujero que tenía el tamaño
   * de empresa de la fuente: escrito en cada fila desde el primer día e invisible.
   *
   * Sólo las que se llenaron, y DESPUÉS de la corrida: declarar las ocho por adelantado
   * dejaría media pantalla de columnas vacías en una lista de negocios sin redes.
   */
  const declaradas = new Map(waterfall_.flatMap((e) => (e.extraColumns ?? []).map((c) => [c.key, c.label] as const)));
  for (const key of extraLlenas) {
    const label = declaradas.get(key);
    if (!label) continue;
    await addColumn({ listId: args.listId, key, label, kind: "manual" }).catch(() => {});
  }

  // La explicación sólo aparece cuando hace falta: si llenó algo, el número habla solo.
  // Los motivos, cada uno con su cuenta: «2 ya tenían correo · 1 sin sitio web» dice qué
  // pasó de verdad. Una frase sola para motivos opuestos manda a buscar un problema que
  // no existe.
  let note: string | null = null;
  if (skipped > 0) {
    const partes = [...motivos.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([m, n]) => `${n} ${m}`);
    note = skipped === total ? `ninguna se pudo: ${partes.join(" · ")}` : `${partes.join(" · ")}`;
  }
  return { done, total, filled, skipped, note };
}

/**
 * Copia a la columna base `email` lo que encontró una columna de enriquecimiento.
 *
 * Existe porque el envío lee `row.email` y no un JSON: la columna descubre, esto promueve.
 * Se hace explícito y no automático — quien mira la lista decide si ese correo le convence.
 */
export async function promoteToEmail(listId: number, key: string): Promise<number> {
  return promoteToBase(listId, key, "email");
}

/**
 * Pasa lo que encontró una columna a una columna BASE.
 *
 * ⚠️ Existe para el caso que pasó el 2026-08-23: una columna «Dirección» duplicada, creada
 * antes de que pedir una etiqueta base reusara la base, y YA CON DATOS. Borrarla tiraba el
 * trabajo y dejarla dejaba dos columnas con el mismo nombre. Faltaba la tercera salida:
 * mover el dato a donde debía estar.
 *
 * NUNCA pisa: sólo llena donde la base está vacía. Lo que ya estaba lo puso alguien o vino
 * de la fuente, y una promoción no es motivo para perderlo.
 */
export async function promoteToBase(listId: number, key: string, baseKey: string): Promise<number> {
  if (!BASE_FIELD_KEYS.has(baseKey)) return 0;
  const rows = await listRows(listId);
  const stmts: { sql: string; args: unknown[] }[] = [];
  for (const r of rows) {
    const v = r.data[key]?.v?.trim();
    if (!v) continue;
    if (String((r as unknown as Record<string, unknown>)[baseKey] ?? "").trim()) continue;
    // Un correo tiene que parecerlo: promover basura a la columna que usa el ENVÍO es
    // exactamente cómo se quema un dominio.
    if (baseKey === "email" && !v.includes("@")) continue;
    stmts.push({ sql: `UPDATE gt_prosp_rows SET ${baseKey} = ? WHERE id = ?`, args: [v, r.id] });
  }
  if (!stmts.length) return 0;
  // Por lotes: una sentencia por fila contra sqld son ~290ms cada una — 10 mil filas serían
  // casi una hora (medido el 2026-08-22).
  for (let i = 0; i < stmts.length; i += 400) await dbqMany(stmts.slice(i, i + 400));
  return stmts.length;
}

/** Las llaves de columna base que se pueden escribir. Lista cerrada: van en SQL directo. */
const BASE_FIELD_KEYS = new Set(["name", "phone", "email", "website", "address", "category"]);
