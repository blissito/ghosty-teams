// Transforma el HTML del agente EN CONSTRUCCIÓN en un documento que el navegador
// pueda pintar DESDE EL PRIMER CHUNK.
//
// El problema: un navegador no dibuja nada mientras el HTML va en el <head> — el
// <body> ni existe todavía — y el agente tarda ~2KB en llegar ahí. Eso se veía como
// pantalla en negro. Como el servidor escribe los bytes, abrimos el documento de
// inmediato y todo lo del agente entra DENTRO del body ya abierto: cada <style> y
// cada sección se aplica y se dibuja conforme llega. Un <style> o un <script> dentro
// del body es válido, y Tailwind Play observa el DOM, así que sigue funcionando.
//
// Es incremental de verdad: se llama con el SUFIJO nuevo de la fuente y devuelve los
// bytes a escribir. Nunca parte una etiqueta a la mitad (guarda el `<…` incompleto).
// Scrollbar del artefacto = el mismo del chat (delgado, morado, pista transparente). Sin
// esto el iframe usa el del sistema: una barra BLANCA gruesa dentro de un panel oscuro.
// `color-scheme: dark` además evita el flash blanco del canvas del documento.
export const ARTIFACT_CHROME_CSS =
  `html{color-scheme:dark;scrollbar-width:thin;scrollbar-color:rgba(139,92,246,.4) transparent}` +
  `::-webkit-scrollbar{width:6px;height:6px}` +
  `::-webkit-scrollbar-track{background:transparent}` +
  `::-webkit-scrollbar-thumb{background:rgba(139,92,246,.35);border-radius:9999px}` +
  `:hover::-webkit-scrollbar-thumb{background:rgba(139,92,246,.6)}`;

const BOOT_CSS =
  `#gt-boot{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;gap:10px;` +
  `font:500 13px system-ui,sans-serif;color:#8b8b9e;background:#1b1b26}` +
  `#gt-boot i{width:3px;height:16px;background:#8b5cf6;border-radius:2px;animation:gtb 1s steps(2) infinite}` +
  `@keyframes gtb{50%{opacity:0}}`;

export function makeArtifactHtmlTransform(): (src: string) => string {
  let opened = false;
  let buf = "";
  return (src: string): string => {
    let out = "";
    if (!opened) {
      opened = true;
      out +=
        `<!doctype html><html><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<style>${ARTIFACT_CHROME_CSS}${BOOT_CSS}</style></head><body>` +
        // ARTEFACTO VACÍO: una marca propia del documento, visible desde el byte cero.
        // Es la línea base — si esto no se ve en el panel, el iframe no está cargando la
        // respuesta (y el problema no es el contenido del agente). Se borra sola en cuanto
        // llega el primer nodo real del artefacto.
        `<div id="gt-boot"><i></i><span>artefacto</span></div>` +
        `<script>new MutationObserver((m,o)=>{for(const r of m)for(const n of r.addedNodes)` +
        `if(n.nodeType===1&&n.id!=="gt-boot"){document.getElementById("gt-boot")?.remove();o.disconnect();return}})` +
        `.observe(document.body,{childList:true})</script>`;
    }
    buf += src;
    const lt = buf.lastIndexOf("<");
    const cut = lt !== -1 && buf.indexOf(">", lt) === -1 ? lt : buf.length;
    let seg = buf.slice(0, cut);
    buf = buf.slice(cut);
    // Fuera la envoltura del documento del agente: su contenido vive en NUESTRO body.
    seg = seg
      .replace(/<!doctype[^>]*>/gi, "")
      .replace(/<\/?html[^>]*>/gi, "")
      .replace(/<\/?head[^>]*>/gi, "")
      .replace(/<\/body\s*>/gi, "");
    // Su <body class="…"> ya no puede abrir un body: trasladamos sus atributos al body
    // real, para que el fondo/tipografía del artefacto se apliquen igual.
    seg = seg.replace(/<body([^>]*)>/gi, (_m, attrs: string) => {
      const cls = /class\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? "";
      const sty = /style\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? "";
      return `<script>document.body.className=${JSON.stringify(cls)};document.body.style.cssText=${JSON.stringify(sty)}</script>`;
    });
    return out + seg;
  };
}
