// Exportar un documento a .docx y a PDF, SIEMPRE desde los BLOQUES.
//
// Los bloques ya son la verdad del documento (sobre `v:1`), así que exportar desde ahí es
// lo único coherente. El camino viejo pasaba por markdown y por EasyBits, y markdown no
// puede expresar una tabla SIN bordes: por eso cuatro firmas lado a lado bajaban con la
// rejilla puesta en Word.
//
// **No hay mapeo escrito a mano.** Se usa el exportador OFICIAL de BlockNote
// (`@blocknote/xl-docx-exporter`, versión clavada a la de `@blocknote/core`) con sus
// mappings por defecto, que ya cubren todo lo que el editor puede producir — incluido
// `columnList`/`column`, y ya con `borders: nil`. O sea que las firmas en columnas salen
// sin rejilla de fábrica.
//
// Para PDF NO hay un segundo motor: se arma el HTML del documento y lo imprime
// `render-svc` (Chromium), que es el servicio de la flota que ya hace esto, on-demand. Así
// el PDF sale con el CSS real del documento en vez del layout de otra librería.
import { type BrandKit, brandFaces, brandFontStacks, brandPrintVars } from "../lib/brand-tokens";
import type { DocBlock } from "../lib/doc-blocks";

/**
 * Bloques → bytes de un .docx.
 *
 * Se usa `toBlob` y no el `Packer` de `docx` para no declarar `docx` como dependencia
 * directa: es un detalle interno del exportador y no queremos atarnos a su versión.
 */
export async function blocksToDocx(blocks: DocBlock[], title: string): Promise<Buffer> {
  const { DOCXExporter, docxDefaultSchemaMappings } = await import("@blocknote/xl-docx-exporter");
  const { docSchema } = await import("./doc-blocks.server");
  const schema = (await docSchema()) as never;

  const exporter = new DOCXExporter(schema, docxDefaultSchemaMappings as never, {
    resolveFileUrl: ourFiles,
  } as never);

  // Locale explícito: sin él Word decide con el idioma de la máquina de quien abre, y un
  // documento en español con corrector en inglés sale subrayado de rojo entero.
  // El título va en las propiedades del archivo: es lo que Word enseña al imprimir y en
  // "Información", y un documento de despacho sin título ahí se ve descuidado.
  // Y sigue el idioma de la app: quien escribe en inglés produce documentos en inglés, y
  // con "es-MX" clavado Word se los subrayaba enteros.
  const { currentLocale } = await import("./locale.server");
  const { intlLocale } = await import("../i18n.core");
  const brand = await import("./brand.server")
    .then((m) => m.activeBrandKit())
    .catch(() => null);
  const blob = await exporter.toBlob(blocks as never, {
    locale: intlLocale(await currentLocale()),
    documentOptions: { title, styles: docxBrandStyles(brand) },
  } as never);
  return Buffer.from(await blob.arrayBuffer());
}

/**
 * Los estilos de Word que impone la marca: la familia del cuerpo y la de los títulos.
 *
 * Aquí SÓLO van fuentes, no colores. En Word un documento con texto de color se ve como
 * una presentación, no como un escrito, y lo que sale de aquí se firma. El membrete tampoco
 * entra: el .docx es el archivo EDITABLE, y quien lo abre suele tener ya su plantilla con
 * papel membretado — meterle el nuestro lo obliga a borrarlo.
 *
 * `undefined` cuando no hay kit → el exportador usa sus defaults de siempre.
 */
function docxBrandStyles(kit: BrandKit | null): Record<string, unknown> | undefined {
  const heading = kit?.fonts?.heading?.trim();
  const body = kit?.fonts?.body?.trim();
  if (!heading && !body) return undefined;
  const titulos = ["Heading1", "Heading2", "Heading3", "Heading4"].map((id) => ({
    id,
    name: id,
    run: { font: heading || body },
  }));
  return {
    default: { document: { run: { font: body || heading } } },
    paragraphStyles: titulos,
  };
}

/**
 * Bloques → HTML autocontenido, listo para que Chromium lo imprima.
 *
 * `blocksToFullHTML` es del propio `@blocknote/server-util` (el mismo que ya convierte
 * markdown ↔ bloques), así que el árbol sale exactamente como el editor lo entiende. Lo
 * que añadimos es la hoja de estilo de impresión: el CSS del editor vive en `styles.css`
 * bajo `.gt-doc` y NO se puede reusar tal cual (trae los adornos de BlockNote y depende
 * del layout del panel), así que aquí va la versión de PAPEL — las mismas familias,
 * tamaños y espaciados, sin nada de la interfaz.
 */
export async function blocksToPrintHtml(
  blocks: DocBlock[],
  title: string,
  /** Sólo para el preview de Ajustes → Marca. En producción se resuelve el activo. */
  brandOverride?: BrandKit | null
): Promise<string> {
  const { ServerBlockNoteEditor } = await import("@blocknote/server-util");
  const { docSchema } = await import("./doc-blocks.server");
  const editor = ServerBlockNoteEditor.create({ schema: await docSchema() } as never) as unknown as {
    blocksToFullHTML(blocks: unknown[]): Promise<string>;
  };
  const inner = await inlineImages(await editor.blocksToFullHTML(blocks as unknown[]));

  // El kit se resuelve AQUÍ y no en cada llamador: los dos caminos que producen PDF
  // (la ruta del botón y el adjunto de `email_send`) tienen que dar el mismo papel.
  const brand =
    brandOverride !== undefined
      ? brandOverride
      : await import("./brand.server")
          .then((m) => m.activeBrandKit())
          .catch(() => null);

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>${fuentesEmbebidas(catalogFaces(brand))}\n${await uploadedFaces(brand)}\n${PRINT_CSS}\n${brandPrintCss(brand)}\n${brandFontCss(brand)}</style>
</head><body><article class="gt-print">${await brandHeader(brand)}${inner}</article></body></html>`;
}

/** Las caras del CATÁLOGO que usa este kit, para incrustarlas desde disco. */
function catalogFaces(kit: BrandKit | null): { family: string; file: string }[] {
  if (!kit) return [];
  return brandFaces(kit)
    .filter((f) => f.diskFile)
    .map((f) => ({ family: f.family, file: f.diskFile as string }));
}

/**
 * Las caras SUBIDAS por el cliente. Van aparte porque no están en disco: se bajan de
 * storage y se incrustan igual que el logo — Chromium corre dentro de `render-svc` y no
 * alcanza nuestro bucket, así que una URL saldría como fuente ausente sin avisar.
 */
async function uploadedFaces(kit: BrandKit | null): Promise<string> {
  if (!kit) return "";
  const subidas = brandFaces(kit).filter((f) => !f.diskFile);
  if (!subidas.length) return "";
  const out: string[] = [];
  for (const f of subidas) {
    try {
      const blob = await ourFiles(f.src);
      const buf = Buffer.from(await blob.arrayBuffer());
      if (buf.length <= EMPTY_PNG.length) continue;
      out.push(
        `@font-face{font-family:"${f.family}";font-style:normal;font-weight:400 700;font-display:block;src:url(data:font/woff2;base64,${buf.toString("base64")}) format("woff2")}`
      );
    } catch (e) {
      // Una fuente que no se pudo traer no puede impedir que salga el documento.
      console.error("[doc print] fuente de marca:", (e as Error).message);
    }
  }
  return out.join("\n");
}

/** Las familias del kit aplicadas al papel. Sin kit, cadena vacía. */
function brandFontCss(kit: BrandKit | null): string {
  if (!kit) return "";
  const f = brandFontStacks(kit);
  return `body{font-family:${f.body}} h1,h2,h3,h4{font-family:${f.heading}}`;
}

/** El `:root` que pisa los fallbacks de PRINT_CSS. Sin kit, cadena vacía. */
function brandPrintCss(kit: BrandKit | null): string {
  if (!kit) return "";
  const vars = Object.entries(brandPrintVars(kit))
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
  return `:root{${vars}}`;
}

/**
 * El membrete. Va INCRUSTADO en base64 igual que el resto de las imágenes: el PDF lo
 * imprime Chromium dentro de `render-svc`, que no alcanza nuestro storage — un `<img>`
 * con la URL pública saldría como hueco, y un hueco no avisa.
 */
async function brandHeader(kit: (BrandKit & { logoKey?: string | null }) | null): Promise<string> {
  if (!kit?.logoUrl) return "";
  try {
    // ⚠️ Por KEY, no por URL: Chromium corre dentro de `render-svc` y no alcanza nuestro
    // origen, así que pedirle `/api/brand-asset/…` daría un hueco. Se leen los bytes del
    // storage y se incrustan, igual que el resto de las imágenes.
    const buf = kit.logoKey
      ? await (await import("./storage.server")).getBytes(kit.logoKey, "public")
      : Buffer.from(await (await ourFiles(kit.logoUrl)).arrayBuffer());
    if (!buf || buf.length <= EMPTY_PNG.length) return "";
    const mime = mimeDeUrl(kit.logoKey || kit.logoUrl);
    const src = `data:${mime};base64,${buf.toString("base64")}`;
    return `<header class="gt-brand"><img src="${src}" alt="${escapeHtml(kit.name)}"></header>`;
  } catch (e) {
    // Un logo que no se pudo traer no puede impedir que salga el documento.
    console.error("[doc print] logo de marca:", (e as Error).message);
    return "";
  }
}

/**
 * Sustituye cada `src` de imagen por un `data:` URI.
 *
 * El HTML de impresión lo renderiza Chromium DENTRO de `render-svc`, otro servicio
 * de la flota: un `/api/attachment/<id>` es same-origin y además autenticado, así
 * que desde ahí no se alcanza. Sin esto el .docx saldría con las fotos y el PDF con
 * huecos — que es peor que fallar, porque el hueco no avisa.
 *
 * Reusa `ourFiles`, el mismo resolvedor del export a .docx (storage propio, con
 * fetch como respaldo para urls ajenas), así que las dos salidas ven exactamente
 * las mismas imágenes.
 */
async function inlineImages(html: string): Promise<string> {
  const SRC = /(<img\b[^>]*?\ssrc=")([^"]+)(")/gi;
  const urls = [...new Set([...html.matchAll(SRC)].map((m) => m[2]))].filter(
    (u) => !u.startsWith("data:")
  );
  if (!urls.length) return html;

  const dataUri = new Map<string, string>();
  await Promise.all(
    urls.map(async (u) => {
      try {
        const blob = await ourFiles(u);
        const buf = Buffer.from(await blob.arrayBuffer());
        // ourFiles devuelve el pixel vacío cuando no pudo traerla: incrustarlo
        // borraría la imagen sin dejar rastro. Mejor dejar el src original y que
        // el hueco quede a la vista.
        if (buf.length <= EMPTY_PNG.length) return;
        const mime = blob.type || mimeDeUrl(u);
        dataUri.set(u, `data:${mime};base64,${buf.toString("base64")}`);
      } catch (e) {
        console.error("[doc print] incrustar imagen falló", e);
      }
    })
  );
  if (!dataUri.size) return html;
  return html.replace(SRC, (todo, pre, url, post) =>
    dataUri.has(url) ? `${pre}${dataUri.get(url)}${post}` : todo
  );
}

/** El `Blob` de nuestro storage llega sin `type`; la extensión es lo que queda. */
function mimeDeUrl(url: string): string {
  const ext = url.split("?")[0].match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  return ext === "jpg" || ext === "jpeg"
    ? "image/jpeg"
    : ext === "webp"
      ? "image/webp"
      : ext === "gif"
        ? "image/gif"
        : ext === "svg"
          ? "image/svg+xml"
          : "image/png";
}

/**
 * HTML → PDF, por `render-svc` (Chromium) a través de Studio.
 *
 * No se llama a la caja de render directo: es de la flota y el mesh enruta por el dueño del
 * llamador, así que desde la caja de Teams contesta 503. Studio ya sabe dónde vive —la
 * resuelve para inyectar `GS_RENDER_URL`— y hace de puente con el MISMO contrato HMAC que
 * ya usa la miniatura de PDF (`published-attach.server.ts`). El proxy público despierta la
 * caja, que vive hibernada: el primer PDF puede tardar unos segundos.
 *
 * Devuelve null ante cualquier fallo; la ruta lo traduce a 502 y el botón avisa. NO hay
 * motor de respaldo a propósito: un segundo generador daría un PDF distinto al de siempre,
 * y "a veces se ve de otra forma" es peor que "ahora no se pudo".
 */
export async function htmlToPdf(html: string): Promise<Buffer | null> {
  try {
    const { nativeRuntimeBase, partnerHeaders } = await import("./ghosty-runtime.server");
    const base = await nativeRuntimeBase();
    if (!base) {
      console.error("[doc export] sin runtime nativo: no hay a quién pedirle el PDF");
      return null;
    }
    const { currentNamespace } = await import("./tenant.server");
    const body = JSON.stringify({ html });
    const res = await fetch(`${base}/api/v2/render/pdf`, {
      method: "POST",
      headers: partnerHeaders(body, await currentNamespace()),
      body,
      // Más que el timeout de Studio (60s) para no cortar antes que él y perder su mensaje.
      signal: AbortSignal.timeout(70_000),
    });
    if (!res.ok) {
      console.error(`[doc export] pdf: studio devolvió ${res.status}`);
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    console.error("[doc export] pdf falló:", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * De dónde salen las imágenes del documento.
 *
 * ⚠️ El default del exportador las manda por un **proxy de BlockNote**
 * (`corsproxy.api.blocknotejs.org`). Un documento nuestro puede ser un expediente: sus
 * imágenes no salen a un tercero. Aquí se bajan directo, y si la URL es de nuestro
 * storage se lee del bucket sin pasar por la red pública.
 *
 * Si una imagen falla se devuelve un pixel vacío en vez de tirar el export: perder la
 * descarga entera por una imagen rota sería peor que un hueco.
 */
async function ourFiles(url: string): Promise<Blob> {
  try {
    const storage = await import("./storage.server");

    // ⚠️ Primero lo NUESTRO, y es el caso más común: `rehostMarkdownImages`
    // (published-attach.server.ts) reescribe TODA imagen de un documento a
    // `/api/attachment/<fileId>`, o sea que ésta es la forma que la plataforma
    // produce. Es relativa y autenticada: `new URL()` tira, y un `fetch` de una
    // ruta relativa tira en Node — se caía al `catch` y devolvía el pixel vacío.
    // Resultado: toda imagen bien re-hospedada salía invisible en el .docx y como
    // hueco en el PDF. Se resuelve con el mismo `mintReadUrl` que usa la ruta HTTP
    // (routes/api.attachment.$id.ts): firma ~1h y no necesita cookie, así que el
    // fetch de abajo sí la alcanza.
    const fileId = attachmentId(url);
    if (fileId) {
      const { mintReadUrl } = await import("./easybits-files.server");
      const firmada = await mintReadUrl(fileId);
      if (firmada) url = firmada;
    }

    const key = keyFromUrl(url);
    if (key && storage.storageConfigured()) {
      const bytes = await storage.getBytes(key, "private");
      if (bytes) return new Blob([new Uint8Array(bytes)]);
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (res.ok) return await res.blob();
    console.error(`[doc export] imagen ${res.status}: ${url.slice(0, 120)}`);
  } catch (e) {
    console.error("[doc export] imagen falló", e);
  }
  return new Blob([EMPTY_PNG]);
}

/**
 * `/api/attachment/<fileId>` → el fileId. Acepta la forma relativa (la que escribe
 * `rehostMarkdownImages`) y la absoluta contra nuestro propio origen, porque el
 * editor colab guarda la que el navegador tenía resuelta.
 */
function attachmentId(url: string): string | null {
  const m = String(url).match(/^(?:https?:\/\/[^/]+)?\/api\/attachment\/([\w.-]+)(?:[?#]|$)/);
  return m ? m[1] : null;
}

/** `.../t3/<key>.png` o el link branded → la key del bucket. Null si es externa. */
function keyFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const base = process.env.ARTIFACT_PUBLIC_BASE ?? "";
    const own = base && url.startsWith(base.replace(/\/$/, ""));
    const path = u.pathname.replace(/^\/+/, "");
    if (own) return path.startsWith("t3/") ? path : `t3/${path}`;
    if (path.startsWith("t3/")) return path;
    return null;
  } catch {
    return null;
  }
}

// PNG de 1×1 transparente: el hueco de una imagen que no se pudo traer.
const EMPTY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// CSS de PAPEL. Deliberadamente no importa `styles.css`: eso trae los adornos del editor
// (`.bn-*`), depende del ancho del panel y arrastraría Tailwind entero. Lo que se conserva
// es la tipografía y el ritmo del documento, que es lo que la gente reconoce.
/**
 * Inter INCRUSTADA en el HTML de impresión.
 *
 * El PDF lo hace el Chromium de una caja de la flota, que sólo tiene las fuentes del
 * sistema: pedir "Inter" a secas caía en la serif de respaldo y el PDF salía con otra
 * tipografía que el editor. (Antes el CSS pedía `Iowan Old Style`, que es de macOS y en la
 * caja tampoco existe — de ahí la Georgia que se veía.)
 *
 * Son ~52KB en tres pesos, leídos del disco UNA vez por proceso. Se paga en el PDF, que ya
 * tarda segundos porque despierta la caja.
 */
/**
 * ⚠️ El caché es un `Map` POR CLAVE, no una global. Cuando era una sola variable de
 * módulo, incrustar la fuente de un tenant se la habría servido al PDF del SIGUIENTE:
 * el proceso es compartido entre workspaces. Con fuentes de marca eso deja de ser
 * hipotético, así que la clave lleva el juego de archivos.
 */
const fuentesCache = new Map<string, string>();

function fuentesEmbebidas(extra: { family: string; file: string }[] = []): string {
  const clave = extra.map((e) => `${e.family}:${e.file}`).sort().join("|");
  const hit = fuentesCache.get(clave);
  if (hit !== undefined) return hit;
  let out = "";
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const pesos: Array<[string, number]> = [
      ["inter-v12-latin-regular.woff2", 400],
      ["inter-v12-latin-600.woff2", 600],
      ["inter-v12-latin-700.woff2", 700],
    ];
    const caras: string[] = [];
    for (const [archivo, peso] of pesos) {
      // Mismo orden que `mascotInline`: el build servido primero, el repo después.
      for (const dir of [".output/public", "public", "build/client"]) {
        const p = path.resolve(process.cwd(), dir, "fonts", archivo);
        if (!fs.existsSync(p)) continue;
        const b64 = fs.readFileSync(p).toString("base64");
        caras.push(
          `@font-face{font-family:"Inter";font-style:normal;font-weight:${peso};font-display:block;src:url(data:font/woff2;base64,${b64}) format("woff2")}`
        );
        break;
      }
    }
    // Las caras de MARCA, del catálogo en disco. Una fuente subida por el cliente no se
    // incrusta aquí: vive en storage y la resuelve `brandFacesForPdf`.
    for (const e of extra) {
      for (const dir of [".output/public", "public", "build/client"]) {
        const p = path.resolve(process.cwd(), dir, "fonts", e.file);
        if (!fs.existsSync(p)) continue;
        const b64 = fs.readFileSync(p).toString("base64");
        caras.push(
          `@font-face{font-family:"${e.family}";font-style:normal;font-weight:400 700;font-display:block;src:url(data:font/woff2;base64,${b64}) format("woff2")}`
        );
        break;
      }
    }
    out = caras.join("\n");
    if (!caras.length) console.warn("[doc export] sin Inter en disco: el PDF saldrá con la fuente del sistema");
  } catch (e) {
    console.warn("[doc export] no pude incrustar Inter:", (e as Error).message);
  }
  fuentesCache.set(clave, out);
  return out;
}

/**
 * Los colores del papel, como variables con FALLBACK al valor de siempre. Sin kit el PDF
 * sale byte a byte como salía; con kit, `brandVars()` emite el `:root` que las pisa.
 *
 * Las FUENTES del kit SÍ entran, incrustadas en base64 por `fuentesEmbebidas(extra)` (las
 * del catálogo) y por `uploadedFaces()` (las que sube el cliente). El caché de fuentes es
 * un `Map` por juego de archivos, no una global: con una global, la fuente de un tenant se
 * le habría servido al PDF del siguiente.
 */
/** Exportado para que el detector de tokens muertos (brand-registry.test) lo lea. */
export const PRINT_CSS = `
@page { size: Letter; margin: 2.2cm 2cm; }
*{ box-sizing:border-box }
body{ margin:0; color:var(--pr-ink,#16161a); font:11pt/1.6 "Inter", ui-sans-serif, system-ui, sans-serif; }
.gt-brand{ display:flex; align-items:center; margin:0 0 1.6em; padding:0 0 .9em; border-bottom:calc(var(--edge,1px) * 2) solid var(--pr-brand,#d8d3e4) }
.gt-brand img{ max-height:52px; max-width:46%; width:auto; object-fit:contain }
.gt-print{ max-width:none }
h1,h2,h3,h4{ font-family:"Inter",ui-sans-serif,system-ui,sans-serif; line-height:1.25; margin:1.4em 0 .5em; page-break-after:avoid; letter-spacing:var(--tracking,0) }
h1{ font-size:19pt; font-weight:700 } h2{ font-size:14pt } h3{ font-size:12pt } h4{ font-size:11pt }
p{ margin:0 0 .7em; orphans:3; widows:3 }
ul,ol{ margin:0 0 .7em 1.4em; padding:0 }
li{ margin:.15em 0 }
blockquote{ margin:1em 0; padding-left:1em; border-left:calc(var(--edge,1px) * 3) solid var(--pr-line,#d8d3e4); color:var(--pr-muted,#3f3f46) }
code{ font:11pt/1.4 "SFMono-Regular",Menlo,monospace; background:#f4f4f7; padding:.1em .3em; border-radius:var(--radius-xs,3px) }
pre{ background:#f4f4f7; padding:.8em 1em; border-radius:var(--radius-md,6px); overflow:visible; white-space:pre-wrap; page-break-inside:avoid }
table{ border-collapse:collapse; width:100%; margin:1em 0; page-break-inside:avoid }
th,td{ border:var(--edge,1px) solid var(--pr-line,#c9c4d6); padding:.4em .6em; text-align:left; vertical-align:top }
th{ background:var(--pr-tint,#f4edfd); font-weight:700 }
img{ max-width:100%; height:auto }
hr{ border:0; border-top:var(--edge,1px) solid var(--pr-line,#d8d3e4); margin:1.6em 0 }
/* Columnas: en papel son la maqueta de las firmas, y NO llevan rejilla — igual que en el
   .docx, donde el exportador oficial ya las saca con los bordes en nil. */
[data-node-type="columnList"]{ display:flex; gap:1.2cm; page-break-inside:avoid }
[data-node-type="column"]{ flex:1 1 0 }
/* Los adornos del editor no son el documento. Por especificidad (.gt-print antepuesto),
   nunca con !important: aquí no compite nadie, y esa regla está prohibida en el proyecto. */
.gt-print .bn-side-menu,.gt-print .bn-formatting-toolbar,.gt-print .bn-slash-menu,.gt-print [data-gt-marca]{ display:none }
`;
