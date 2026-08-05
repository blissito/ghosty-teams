import { Children, cloneElement, createElement, isValidElement, memo } from "react";
import { Streamdown, type StreamdownProps } from "streamdown";
import * as nodeEmoji from "node-emoji";

// Streamdown (Vercel) es stream-aware: completa markdown incompleto EN VIVO (tablas/code
// fences a medio cerrar) mientras entran tokens → sin el parpadeo de react-markdown que la
// caja caliente dejó más visible. Es superset de react-markdown: reusamos el mismo shape de
// `components` (menciones + links de artefacto + cap de imagen). GFM + hardening/sanitize +
// resaltado de código (Shiki, lazy) vienen built-in.
type Components = NonNullable<StreamdownProps["components"]>;

// Resalta @menciones Y emojis custom (`:name:` → <img>) dentro del árbol ya renderizado
// (recursivo), sin tocar código ni links. `emojiMap` = nombre→file_id del workspace.
function highlightText(children: React.ReactNode, emojiMap: Map<string, string>, onMention?: (handle: string) => void): React.ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      // Boundary a la izquierda SIN lookbehind: Safari <16.4 rechaza `(?<!…)` en el
      // literal → SyntaxError al parsear el bundle → crashea toda la app en esos
      // browsers. Tokenizamos `@\w+` (mención) y `:name:` (emoji custom) y validamos
      // EN CÓDIGO que el char previo de una @ no sea palabra/@/. → NO matchea el "@gmail"
      // dentro de un email. Slack usa tokens <@Uxxx>; aquí, en texto plano, el equivalente.
      const out: React.ReactNode[] = [];
      // Los acentos van EXPLÍCITOS: `\w` no los incluye, así que `@aquí` se pintaba
      // como `@aqu` + "í" suelto. Mismo alfabeto que el matcher de menciones del server.
      const re = /@[\wáéíóúñÁÉÍÓÚÑ]+|:[a-z0-9_]+:/g;
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(child)) !== null) {
        const tok = m[0];
        if (tok[0] === "@") {
          const prev = m.index > 0 ? child[m.index - 1] : "";
          if (/[\w@.]/.test(prev)) continue; // pegado a palabra/@/. (local-part) → no es mención
          if (m.index > last) out.push(child.slice(last, m.index));
          out.push(
            <span
              key={m.index}
              onClick={onMention ? () => onMention(tok.slice(1)) : undefined}
              className={`rounded bg-brand/15 px-1 font-medium text-brand ${onMention ? "cursor-pointer hover:bg-brand/25" : ""}`}
            >
              {tok}
            </span>
          );
          last = m.index + tok.length;
        } else {
          // `:name:` → emoji custom del workspace (imagen) tiene PRECEDENCIA (estilo
          // Slack); si no, shortcode estándar (unicode via node-emoji); si ninguno, literal.
          const name = tok.slice(1, -1);
          const fileId = emojiMap.get(name);
          if (fileId) {
            if (m.index > last) out.push(child.slice(last, m.index));
            out.push(
              <img
                key={m.index}
                src={`/api/attachment/${encodeURIComponent(fileId)}`}
                alt={tok}
                title={tok}
                loading="lazy"
                decoding="async"
                className="inline-block h-[1.25em] w-[1.25em] object-contain align-[-0.2em]"
              />
            );
            last = m.index + tok.length;
          } else if (nodeEmoji.has(name)) {
            // Shortcode estándar → carácter unicode (texto). El font-size del jumbo lo agranda.
            if (m.index > last) out.push(child.slice(last, m.index));
            out.push(nodeEmoji.get(name));
            last = m.index + tok.length;
          } else {
            continue; // desconocido → se deja literal
          }
        }
      }
      if (last < child.length) out.push(child.slice(last));
      return out.length ? out : child;
    }
    if (isValidElement(child)) {
      const type = child.type as unknown as string;
      if (type === "code" || type === "pre" || type === "a") return child;
      const kids = (child.props as { children?: React.ReactNode }).children;
      if (kids != null) return cloneElement(child, undefined, highlightText(kids, emojiMap, onMention));
    }
    return child;
  });
}

// Envuelve los contenedores de texto para inyectar el resaltado; highlightText
// desciende a strong/em/etc. anidados, así que basta con los bloques de nivel alto.
const TEXT_TAGS = ["p", "li", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote"] as const;

// ⚠️ `td`/`th` están en TEXT_TAGS para poder inyectar emojis y menciones dentro de una
// celda, y al sustituir el componente de Streamdown se quedaban SIN className: se perdía
// su padding y su peso, y mandaban los defaults de `prose`. De ahí las celdas desparejas.
// Se les devuelve la clase aquí, no se sacan de TEXT_TAGS (el motivo por el que están
// sigue vivo). Ver también TABLE_COMPONENTS abajo.
// Sin color: la celda HEREDA el del contenedor. Es lo que hace que la misma tabla sirva
// en el chat (tokens theme-aware) y en la hoja clara del draft del artefacto, que es
// blanca SIEMPRE — ahí un `text-ink` en tema oscuro saldría casi blanco sobre blanco.
const CELL_CLS: Partial<Record<(typeof TEXT_TAGS)[number], string>> = {
  th: "px-3 py-1.5 text-left align-bottom text-xs font-semibold uppercase tracking-wide",
  td: "px-3 py-1.5 align-top text-sm",
};

function textComponents(emojiMap: Map<string, string>, onMention?: (handle: string) => void): Components {
  return Object.fromEntries(
    TEXT_TAGS.map((tag) => [
      tag,
      ({ node, children, className, ...props }: { node?: unknown; children?: React.ReactNode; className?: string }) =>
        createElement(
          tag,
          { ...props, className: [CELL_CLS[tag], className].filter(Boolean).join(" ") || undefined },
          highlightText(children, emojiMap, onMention)
        ),
    ])
  );
}

// Tablas del chat. Streamdown trae las suyas, pero pintadas con tokens que en este repo
// significan otra cosa o directamente no existen:
//   • `thead` con `bg-muted/80`, y aquí `--color-muted` es un gris de TEXTO → la cabecera
//     salía como una franja gris pizarra a todo lo ancho.
//   • el wrapper usa `bg-sidebar` y `bg-background`, que NO están en nuestro @theme: las
//     utilidades ni se generan, así que quedaban dos bordes anidados sin sus fondos.
// Por eso pintamos nosotros el contenedor en vez de definir sus tokens: `sidebar` y
// `background` son vocabulario de Streamdown y atarnos a sus nombres internos es peor.
// El scroll horizontal se CONSERVA (una tabla ancha no debe romper la burbuja).
// `light` = hoja clara del draft del artefacto: fondo blanco fijo, así que ahí los colores
// no pueden salir de los tokens theme-aware (en tema oscuro pintarían oscuro sobre blanco).
function tableComponents(light?: boolean): Components {
  const line = light ? "border-black/10" : "border-border";
  const head = light ? "bg-black/[0.04]" : "bg-surface-2";
  return {
    // `not-prose`: la salida oficial de @tailwindcss/typography. Sin ella, `prose` le
    // mete `margin: 2em 0` al table —franja vacía dentro de nuestro marco— y un `m-0`
    // NO gana: empatan en especificidad y prose va después en la hoja. Medido.
    // El precio es que las celdas quedan fuera de prose: el color se hereda igual, pero
    // los links hay que pintarlos a mano, de ahí el `[&_a]:text-brand`.
    //
    // ⚠️ Este comentario va AQUÍ, en JS, y no como `{/* … */}` dentro del `return (`:
    // ahí es un segundo hijo suelto junto al <div> y rompe la sintaxis (el build de
    // 1e775cf quedó rojo por eso).
    table: ({ node, children, className, ...props }: { node?: unknown; children?: React.ReactNode; className?: string }) => (
      <div className={`not-prose my-2 w-full overflow-x-auto rounded-lg border [&_a]:text-brand [&_a]:underline ${line}`}>
        <table className={["w-full border-collapse text-left", className].filter(Boolean).join(" ")} {...props}>
          {children}
        </table>
      </div>
    ),
    thead: ({ node, children, ...props }: { node?: unknown; children?: React.ReactNode }) => (
      <thead className={`border-b ${line} ${head}`} {...props}>
        {children}
      </thead>
    ),
    tbody: ({ node, children, ...props }: { node?: unknown; children?: React.ReactNode }) => (
      <tbody className={`divide-y ${light ? "divide-black/10" : "divide-border"}`} {...props}>
        {children}
      </tbody>
    ),
    tr: ({ node, children, ...props }: { node?: unknown; children?: React.ReactNode }) => <tr {...props}>{children}</tr>,
  };
}

const cleanUrl = (u: string) => u.replace(/[.,)]+$/, "");

// Emoji unicode (pictográficos + ZWJ + variation selector + regional + tonos de piel).
const UNICODE_EMOJI = /[\p{Extended_Pictographic}\u200D\uFE0F\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}]/gu;
// ¿El mensaje es SOLO emojis? (custom `:name:` conocidos y/o unicode, más espacios) →
// se renderiza JUMBO (grande), como Slack/Discord. Un `:foo:` que NO es emoji conocido
// cuenta como texto → no jumbo.
function emojiOnly(body: string, emojiMap: Map<string, string>): { jumbo: boolean; count: number } {
  const trimmed = body.trim();
  if (!trimmed) return { jumbo: false, count: 0 };
  const shortcodeTokens = trimmed.match(/:([a-z0-9_]+):/g) ?? [];
  // Cuenta como emoji tanto los custom del workspace como los shortcodes estándar (node-emoji).
  const knownTokens = shortcodeTokens.filter((tok) => {
    const n = tok.slice(1, -1);
    return emojiMap.has(n) || nodeEmoji.has(n);
  });
  const unicode = trimmed.match(UNICODE_EMOJI) ?? [];
  let rest = trimmed.replace(/:([a-z0-9_]+):/g, (full, n) => (emojiMap.has(n) || nodeEmoji.has(n) ? "" : full));
  rest = rest.replace(UNICODE_EMOJI, "").replace(/\s+/g, "");
  const count = knownTokens.length + unicode.length;
  return { jumbo: rest.length === 0 && count > 0, count };
}

// Render Markdown seguro (GFM + sanitize) con look de chat compacto.
// `artifactUrl`/`onOpenArtifact`: si un link apunta al artefacto del mensaje, el click
// ABRE el panel (no descarga). El resto de links abren en pestaña nueva.
export const Markdown = memo(function Markdown({
  body,
  artifactUrl,
  onOpenArtifact,
  light,
  emojis,
  onMention,
  onImage,
}: {
  body: string;
  artifactUrl?: string;
  onOpenArtifact?: () => void;
  light?: boolean; // hoja clara (texto negro) para el draft del artefacto
  emojis?: { name: string; file_id: string }[]; // emojis custom → `:name:` inline en el cuerpo
  onMention?: (handle: string) => void; // clic en @mención → hovercard/perfil (estilo Slack)
  onImage?: (src: string, alt?: string) => void; // clic en imagen del agente → panel lateral
}) {
  const emojiMap = new Map((emojis ?? []).map((e) => [e.name, e.file_id]));
  // Mensaje solo-emoji → JUMBO (grande), como Slack. Se salta markdown (no hace falta):
  // highlightText resuelve `:name:` custom → <img> y deja el unicode como texto; el
  // font-size grande del contenedor agranda ambos (el <img> es h-[1.25em], relativo).
  const { jumbo, count } = emojiOnly(body, emojiMap);
  if (jumbo) {
    const sizeCls = count <= 6 ? "text-[2.75rem]" : count <= 12 ? "text-3xl" : "text-2xl";
    return <div className={`${sizeCls} leading-none ${light ? "text-black" : "text-ink"}`}>{highlightText(body, emojiMap, onMention)}</div>;
  }
  const withLinks: Components = {
    ...textComponents(emojiMap, onMention),
    ...tableComponents(light),
    // Imágenes del agente (memes/gráficas) al tamaño de Slack: alto acotado (~320px),
    // ancho de la columna, sin recorte (object-contain). Clic → abre en el PANEL lateral
    // (onImage), no en pestaña nueva; fallback al link si no hay handler. Sin esto una
    // imagen markdown crecía a lo alto de todo el mensaje.
    img: ({ node, src, alt, ...props }: { node?: unknown; src?: string; alt?: string }) => {
      const cls = "max-h-80 w-auto max-w-full rounded-lg border border-border object-contain";
      const im = (
        <img src={src} alt={alt ?? ""} loading="lazy" decoding="async" className={cls} {...props} />
      );
      if (onImage && src) {
        return (
          <button type="button" onClick={() => onImage(src, alt)} className="mt-1 block w-fit cursor-zoom-in">
            {im}
          </button>
        );
      }
      return (
        <a href={src} target="_blank" rel="noreferrer noopener" className="mt-1 block w-fit">
          {im}
        </a>
      );
    },
    a: ({ node, href, children, ...props }: { node?: unknown; href?: string; children?: React.ReactNode }) => {
      const isArtifact = !!(artifactUrl && href && cleanUrl(href) === cleanUrl(artifactUrl) && onOpenArtifact);
      if (isArtifact) {
        return (
          <a
            href={href}
            onClick={(e) => {
              e.preventDefault();
              onOpenArtifact!();
            }}
            className="cursor-pointer"
            {...props}
          >
            {children}
          </a>
        );
      }
      return (
        <a href={href} target="_blank" rel="noreferrer noopener" {...props}>
          {children}
        </a>
      );
    },
  };
  const cls = light
    ? "prose prose-sm max-w-none break-words text-black leading-relaxed prose-headings:font-semibold prose-headings:text-black prose-p:my-0.5 prose-a:text-brand prose-strong:text-black"
    // NO usamos prose-invert (asume fondo oscuro → TODO el texto sale claro: en tema CLARO
    // quedaba claro-sobre-blanco, ilegible — títulos, quotes, código, listas). En su lugar
    // manejamos CADA color de `prose` con sus propias CSS-vars apuntando a nuestros tokens
    // theme-aware (--color-ink/muted/border/brand), que se invierten solos con el tema →
    // contraste correcto en claro Y oscuro para body, títulos, código, blockquotes y bordes.
    : "prose prose-sm max-w-none break-words leading-relaxed " +
      "[--tw-prose-body:var(--color-ink)] [--tw-prose-headings:var(--color-ink)] [--tw-prose-bold:var(--color-ink)] [--tw-prose-links:var(--color-brand)] [--tw-prose-code:var(--color-ink)] [--tw-prose-quotes:var(--color-muted)] [--tw-prose-quote-borders:var(--color-border)] [--tw-prose-bullets:var(--color-muted)] [--tw-prose-counters:var(--color-muted)] [--tw-prose-hr:var(--color-border)] [--tw-prose-captions:var(--color-muted)] [--tw-prose-th-borders:var(--color-border)] [--tw-prose-td-borders:var(--color-border)] " +
      // `pre` es el caso que se escapaba: `prose` asume que un bloque de código va sobre
      // fondo OSCURO, así que pinta su texto en gris claro. Nosotros le damos fondo claro
      // (`prose-pre:bg-surface-3`) → gris claro sobre claro, o sea invisible: un bloque de
      // código en el chat se leía como un rectángulo vacío. Las dos vars van juntas.
      "[--tw-prose-pre-code:var(--color-ink)] [--tw-prose-pre-bg:var(--color-surface-3)] " +
      "prose-p:my-0.5 prose-p:leading-relaxed prose-headings:mb-1 prose-headings:mt-3 prose-headings:font-semibold prose-pre:my-2 prose-pre:bg-surface-3 prose-code:rounded prose-code:bg-surface-3 prose-code:px-1 prose-code:before:content-none prose-code:after:content-none prose-ul:my-2 prose-ol:my-2 prose-li:my-1 prose-li:leading-relaxed prose-hr:my-3";
  return (
    <div className={cls}>
      {/* parseIncompleteMarkdown (default) cierra markdown a medio-stream → sin parpadeo.
          controls=false: sin botones de copiar/descargar en code/tablas (look de chat limpio,
          paridad con el render previo). shikiTheme por defecto resalta el código. */}
      <Streamdown components={withLinks} controls={false} className="min-w-0 break-words">
        {body}
      </Streamdown>
    </div>
  );
});
