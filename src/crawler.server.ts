// ¿El que pide es un crawler de PREVIEW de liga (WhatsApp, Slack, Telegram, iMessage,
// Twitter/X, Facebook, Discord, LinkedIn) y no una persona?
//
// Importa porque la raíz de un tenant rebota al IdP en OTRO dominio
// (`smatch.teams…` → `www.ghosty.studio/login?next=/identity/connect…`), y un crawler
// de preview NO sigue un redirect cross-domain: se queda sin HTML y pinta la tarjeta
// pelona con el host repetido como título. Las etiquetas og:* de `__root` existían
// desde siempre; nadie las llegaba a ver.
//
// Es un chequeo de PRESENTACIÓN, no de auth: lo único que concede es que se renderice
// la tarjeta de login pública en vez del rebote. Un humano que falsifique el UA no gana
// nada — esa pantalla no lleva datos del workspace.
const BOTS =
  /WhatsApp|facebookexternalhit|facebookcatalog|Twitterbot|Slackbot|SkypeUriPreview|TelegramBot|Discordbot|LinkedInBot|Applebot|iMessage|Google-InspectionTool|redditbot|Pinterest|vkShare|W3C_Validator|Embedly|Iframely/i;

export async function isLinkPreviewCrawler(): Promise<boolean> {
  if (typeof window !== "undefined") return false;
  try {
    const { getRequestHeader } = await import("@tanstack/react-start/server");
    return BOTS.test(getRequestHeader("user-agent") || "");
  } catch {
    return false;
  }
}
