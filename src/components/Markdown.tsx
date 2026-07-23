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
      const re = /@\w+|:[a-z0-9_]+:/g;
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
function textComponents(emojiMap: Map<string, string>, onMention?: (handle: string) => void): Components {
  return Object.fromEntries(
    TEXT_TAGS.map((tag) => [
      tag,
      ({ node, children, ...props }: { node?: unknown; children?: React.ReactNode }) =>
        createElement(tag, props, highlightText(children, emojiMap, onMention)),
    ])
  );
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
}: {
  body: string;
  artifactUrl?: string;
  onOpenArtifact?: () => void;
  light?: boolean; // hoja clara (texto negro) para el draft del artefacto
  emojis?: { name: string; file_id: string }[]; // emojis custom → `:name:` inline en el cuerpo
  onMention?: (handle: string) => void; // clic en @mención → hovercard/perfil (estilo Slack)
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
    // Imágenes del agente (memes/gráficas) al tamaño de Slack: alto acotado (~320px),
    // ancho de la columna, sin recorte (object-contain), clic → abre el original en pestaña.
    // Sin esto una imagen markdown crecía a lo alto de todo el mensaje.
    img: ({ node, src, alt, ...props }: { node?: unknown; src?: string; alt?: string }) => (
      <a href={src} target="_blank" rel="noreferrer noopener" className="mt-1 block w-fit">
        <img
          src={src}
          alt={alt ?? ""}
          loading="lazy"
          decoding="async"
          className="max-h-80 w-auto max-w-full rounded-lg border border-border object-contain"
          {...props}
        />
      </a>
    ),
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
    : "prose prose-sm prose-invert max-w-none break-words text-ink leading-relaxed prose-p:my-0.5 prose-p:leading-relaxed prose-headings:mb-1 prose-headings:mt-3 prose-headings:font-semibold prose-pre:my-2 prose-pre:bg-surface-3 prose-code:rounded prose-code:bg-surface-3 prose-code:px-1 prose-code:before:content-none prose-code:after:content-none prose-ul:my-2 prose-ol:my-2 prose-li:my-1 prose-li:leading-relaxed prose-a:text-brand prose-strong:text-ink prose-hr:my-3";
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
