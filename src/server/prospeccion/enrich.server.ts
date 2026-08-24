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
import { dbq } from "../../dbq.server";
import { listRows, setCell, type ProspRow, type Recipe } from "./lists.server";
import { matches, type Filter } from "../../lib/prospeccion-filter";

export type EnrichResult = { v: string | null; verified: boolean };

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
    label: "Correo del sitio",
    requires: "un valor en la columna Sitio web",
    whyNot: (r) => (!r.website ? "sin sitio web" : r.email ? "ya tenían correo" : null),
    writesTo: "email",
    needs: (r) => !!r.website && !r.email,
    async run(r) {
      const domain = domainOf(r.website);
      const homeHtml = await fetchText(r.website!);
      if (homeHtml) {
        const e = bestEmail(emailsIn(homeHtml), domain);
        if (e) return { v: e, verified: true };
      }
      // Segunda pasada: las rutas de contacto habituales. Una sola, no un crawl.
      const base = r.website!.replace(/\/$/, "");
      for (const path of ["/contacto", "/contact", "/nosotros"]) {
        const p = await fetchText(`${base}${path}`);
        if (!p) continue;
        const e = bestEmail(emailsIn(p), domain);
        if (e) return { v: e, verified: true };
      }
      return { v: null, verified: false };
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
      if (res.v) filled++;
      done++;
      args.onProgress?.({ done, total, filled });
    }
  });

  await Promise.all(workers);

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
  const rows = await listRows(listId);
  let n = 0;
  for (const r of rows) {
    const c = r.data[key];
    if (!r.email && c?.v && c.v.includes("@")) {
      await dbq(`UPDATE gt_prosp_rows SET email = ? WHERE id = ?`, [c.v, r.id]);
      n++;
    }
  }
  return n;
}
