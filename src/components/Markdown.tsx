import { Children, cloneElement, createElement, isValidElement } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";

// Resalta @menciones dentro del árbol ya renderizado (recursivo), sin tocar código
// ni links. Conserva el comportamiento del viejo renderBody.
function highlightMentions(children: React.ReactNode): React.ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      return child.split(/(@\w+)/g).map((chunk, i) =>
        /^@\w+$/.test(chunk) ? (
          <span key={i} className="rounded bg-brand/15 px-1 font-medium text-brand">
            {chunk}
          </span>
        ) : (
          chunk
        )
      );
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

// Render Markdown seguro (GFM + sanitize) con look de chat compacto.
export function Markdown({ body }: { body: string }) {
  return (
    <div className="prose prose-sm prose-invert max-w-none break-words text-ink prose-p:my-0.5 prose-pre:my-1 prose-pre:bg-surface-3 prose-code:rounded prose-code:bg-surface-3 prose-code:px-1 prose-code:before:content-none prose-code:after:content-none prose-ul:my-1 prose-ol:my-1 prose-headings:my-1 prose-a:text-brand">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={components}>
        {body}
      </ReactMarkdown>
    </div>
  );
}
