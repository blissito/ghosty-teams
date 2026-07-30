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
  const blob = await exporter.toBlob(blocks as never, {
    locale: "es-MX",
    documentOptions: { title },
  } as never);
  return Buffer.from(await blob.arrayBuffer());
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
export async function blocksToPrintHtml(blocks: DocBlock[], title: string): Promise<string> {
  const { ServerBlockNoteEditor } = await import("@blocknote/server-util");
  const { docSchema } = await import("./doc-blocks.server");
  const editor = ServerBlockNoteEditor.create({ schema: await docSchema() } as never) as unknown as {
    blocksToFullHTML(blocks: unknown[]): Promise<string>;
  };
  const inner = await editor.blocksToFullHTML(blocks as unknown[]);

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>${PRINT_CSS}</style>
</head><body><article class="gt-print">${inner}</article></body></html>`;
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
const PRINT_CSS = `
@page { size: Letter; margin: 2.2cm 2cm; }
*{ box-sizing:border-box }
body{ margin:0; color:#16161a; font:12pt/1.6 "Iowan Old Style", Georgia, serif; }
.gt-print{ max-width:none }
h1,h2,h3,h4{ font-family:"Iowan Old Style",Georgia,serif; line-height:1.25; margin:1.4em 0 .5em; page-break-after:avoid }
h1{ font-size:20pt; font-weight:700 } h2{ font-size:15pt } h3{ font-size:13pt } h4{ font-size:12pt }
p{ margin:0 0 .7em; orphans:3; widows:3 }
ul,ol{ margin:0 0 .7em 1.4em; padding:0 }
li{ margin:.15em 0 }
blockquote{ margin:1em 0; padding-left:1em; border-left:3px solid #d8d3e4; color:#3f3f46 }
code{ font:11pt/1.4 "SFMono-Regular",Menlo,monospace; background:#f4f4f7; padding:.1em .3em; border-radius:3px }
pre{ background:#f4f4f7; padding:.8em 1em; border-radius:6px; overflow:visible; white-space:pre-wrap; page-break-inside:avoid }
table{ border-collapse:collapse; width:100%; margin:1em 0; page-break-inside:avoid }
th,td{ border:1px solid #c9c4d6; padding:.4em .6em; text-align:left; vertical-align:top }
th{ background:#f4edfd; font-weight:700 }
img{ max-width:100%; height:auto }
hr{ border:0; border-top:1px solid #d8d3e4; margin:1.6em 0 }
/* Columnas: en papel son la maqueta de las firmas, y NO llevan rejilla — igual que en el
   .docx, donde el exportador oficial ya las saca con los bordes en nil. */
[data-node-type="columnList"]{ display:flex; gap:1.2cm; page-break-inside:avoid }
[data-node-type="column"]{ flex:1 1 0 }
/* Los adornos del editor no son el documento. Por especificidad (.gt-print antepuesto),
   nunca con !important: aquí no compite nadie, y esa regla está prohibida en el proyecto. */
.gt-print .bn-side-menu,.gt-print .bn-formatting-toolbar,.gt-print .bn-slash-menu,.gt-print [data-gt-marca]{ display:none }
`;
