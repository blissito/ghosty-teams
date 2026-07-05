// Origin de la instancia derivado del request (multitenant, sin env fijo).
// Prioridad: APP_URL override → x-ghosty-origin (ingress teams.formmy.app, que
// EasyBits no toca) → x-forwarded-host (acceso directo sb-xxx) → Host crudo.
export async function reqOrigin(): Promise<string> {
  if (process.env.APP_URL) return process.env.APP_URL;
  const { getRequestHeader, getRequestHost, getRequestProtocol } = await import(
    "@tanstack/react-start/server"
  );
  const ghosty = getRequestHeader("x-ghosty-origin");
  if (ghosty) return ghosty;
  const host = getRequestHeader("x-forwarded-host") || getRequestHost();
  const proto = getRequestHeader("x-forwarded-proto") || getRequestProtocol() || "https";
  return host ? `${proto}://${host}` : "";
}
