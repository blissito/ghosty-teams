import { useEffect, useRef } from "react";
import { useT } from "../../i18n";

/**
 * El correo tal como llega.
 *
 * Dos formas de pintarlo, y la diferencia importa:
 *  · `iframe` (la revisión de envío): `sandbox` sin scripts. Es lo seguro para un HTML que
 *    no controlamos del todo.
 *  · `inline` (el panel del agente): un shadow DOM. El HTML aquí lo arma NUESTRA plantilla
 *    (`prospectEmail`) con la prosa ya escapada, así que no corre nada; a cambio se puede
 *    actualizar en vivo sin recargar —un iframe vuelve a arriba en cada cambio y el agente
 *    cambia el texto cada pocos segundos— y el scroll es el nuestro, no uno anidado.
 */
export function MailPreview({
  html,
  marca,
  className,
  mode = "iframe",
  fill,
}: {
  html: string;
  marca: string | null;
  className?: string;
  mode?: "iframe" | "inline";
  /** Ocupar toda la altura disponible (panel expandido) en vez de las 18rem de la card. */
  fill?: boolean;
}) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (mode !== "inline") return;
    const host = hostRef.current;
    if (!host) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    // Sólo el <body> de la plantilla: el <html>/<head> no pintan nada dentro de un shadow.
    const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
    root.innerHTML = `<style>:host{display:block}a{cursor:pointer}</style><div style="padding:24px 12px;background:#fff">${body}</div>`;
  }, [html, mode]);

  // Los enlaces abren en pestaña nueva: wa.me no se deja enmarcar y navegar aquí rompe la vista.
  const onClick = (e: React.MouseEvent) => {
    const path = e.nativeEvent.composedPath() as HTMLElement[];
    const a = path.find((el) => el instanceof HTMLAnchorElement) as HTMLAnchorElement | undefined;
    if (a?.href) { e.preventDefault(); window.open(a.href, "_blank", "noopener"); }
  };

  const alto = fill ? "h-full" : "h-72";
  return (
    <div className={`${className ?? ""} ${fill ? "flex flex-col h-full min-h-0" : ""}`}>
      <p className="text-[11px] text-muted mb-1.5 shrink-0">
        {marca
          ? `${t("Sale con la marca de")} ${marca}`
          : t("⚠️ Sin marca activa: sale con la de Ghosty. Ponla en Ajustes → Marca.")}
      </p>
      {mode === "inline" ? (
        <div
          ref={hostRef}
          onClick={onClick}
          className={`w-full ${alto} min-h-0 overflow-y-auto rounded-xl border border-border bg-white thin-scroll`}
        />
      ) : (
        <iframe
          title={t("Previsualización")}
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          srcDoc={html.replace(/<html>/i, '<html><head><base target="_blank"></head>')}
          className={`w-full ${alto} rounded-xl border border-border bg-white`}
        />
      )}
    </div>
  );
}
