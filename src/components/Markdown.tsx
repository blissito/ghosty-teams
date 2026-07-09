import { Children, cloneElement, createElement, isValidElement } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";

// Resalta @menciones dentro del árbol ya renderizado (recursivo), sin tocar código
// ni links. Conserva el comportamiento del viejo renderBody.
function highlightMentions(children: React.ReactNode): React.ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      // Boundary a la izquierda SIN lookbehind: Safari <16.4 rechaza `(?<!…)` en el
      // literal → SyntaxError al parsear el bundle → crashea toda la app en esos
      // browsers. Tokenizamos `@\w+` y validamos EN CÓDIGO que el char previo no sea
      // palabra/@/. → NO matchea el "@gmail" dentro de un email (fixtergeek@gmail.com).
      // Slack lo evita con tokens <@Uxxx>; aquí, en texto plano, este es el equivalente.
      const out: React.ReactNode[] = [];
      const re = /@\w+/g;
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(child)) !== null) {
        const prev = m.index > 0 ? child[m.index - 1] : "";
        if (/[\w@.]/.test(prev)) continue; // pegado a palabra/@/. (local-part) → no es mención
        if (m.index > last) out.push(child.slice(last, m.index));
        out.push(
          <span key={m.index} className="rounded bg-brand/15 px-1 font-medium text-brand">
            {m[0]}
          </span>
        );
        last = m.index + m[0].length;
      }
      if (last < child.length) out.push(child.slice(last));
      return out.length ? out : child;
    }
    if (isValidElement(child)) {
      const type = child.type as unknown as string;
      if (type === "code" || type === "pre" || type === "a") return child;
      const kids = (child.props as { children?: React.ReactNode }).children;
      if (kids != null) return cloneElement(child, undefined, highlightMentions(kids));
    }
    return child;
  });
}

// Envuelve los contenedores de texto para inyectar el resaltado; highlightMentions
// desciende a strong/em/etc. anidados, así que basta con los bloques de nivel alto.
const TEXT_TAGS = ["p", "li", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote"] as const;
const components: Components = Object.fromEntries(
  TEXT_TAGS.map((tag) => [
    tag,
    ({ node, children, ...props }: { node?: unknown; children?: React.ReactNode }) =>
      createElement(tag, props, highlightMentions(children)),
  ])
);

const cleanUrl = (u: string) => u.replace(/[.,)]+$/, "");

// Render Markdown seguro (GFM + sanitize) con look de chat compacto.
// `artifactUrl`/`onOpenArtifact`: si un link apunta al artefacto del mensaje, el click
// ABRE el panel (no descarga). El resto de links abren en pestaña nueva.
export function Markdown({
  body,
  artifactUrl,
  onOpenArtifact,
  light,
}: {
  body: string;
  artifactUrl?: string;
  onOpenArtifact?: () => void;
  light?: boolean; // hoja clara (texto negro) para el draft del artefacto
}) {
  const withLinks: Components = {
    ...components,
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
    ? "prose prose-sm max-w-none break-words text-black leading-relaxed prose-headings:font-semibold prose-headings:text-black prose-p:my-2 prose-a:text-brand prose-strong:text-black"
    : "prose prose-sm prose-invert max-w-none break-words text-ink leading-relaxed prose-p:my-2 prose-p:leading-relaxed prose-headings:mb-1 prose-headings:mt-3 prose-headings:font-semibold prose-pre:my-2 prose-pre:bg-surface-3 prose-code:rounded prose-code:bg-surface-3 prose-code:px-1 prose-code:before:content-none prose-code:after:content-none prose-ul:my-2 prose-ol:my-2 prose-li:my-1 prose-li:leading-relaxed prose-a:text-brand prose-strong:text-ink prose-hr:my-3";
  return (
    <div className={cls}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={withLinks}>
        {body}
      </ReactMarkdown>
    </div>
  );
}
