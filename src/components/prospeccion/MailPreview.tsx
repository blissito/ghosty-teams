import { useT } from "../../i18n";

/**
 * El correo tal como llega, en un iframe con `sandbox` vacío.
 *
 * El HTML lo compuso un modelo: no puede correr nada ni heredar los estilos de la app — que
 * además lo harían verse distinto de como llega a Gmail. Lo comparten la revisión de envío
 * y el panel del agente, para que "cómo se ve" sea la misma respuesta en los dos sitios.
 */
export function MailPreview({ html, marca, className }: { html: string; marca: string | null; className?: string }) {
  const t = useT();
  return (
    <div className={className}>
      {/* Con qué marca sale. Es lo primero que hay que comprobar: si al prospecto le llega
          el mascot de Ghosty en vez de la marca de quien prospecta, el remitente no es
          quien dice ser. */}
      <p className="text-[11px] text-muted mb-1.5">
        {marca
          ? `${t("Sale con la marca de")} ${marca}`
          : t("⚠️ Sin marca activa: sale con la de Ghosty. Ponla en Ajustes → Marca.")}
      </p>
      {/* Los enlaces abren en pestaña nueva: sin esto el botón de WhatsApp navegaba DENTRO
          del iframe y wa.me, que no se deja enmarcar, dejaba la vista previa en «rechazó la
          conexión». `allow-popups-to-escape-sandbox` es lo que permite que la pestaña nueva
          sea una página normal; el iframe sigue sin scripts. */}
      <iframe
        title={t("Previsualización")}
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        srcDoc={html.replace(/<html>/i, '<html><head><base target="_blank"></head>')}
        className="w-full h-72 rounded-xl border border-border bg-white"
      />
    </div>
  );
}
