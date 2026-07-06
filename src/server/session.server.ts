// Opciones compartidas de la sesión `gc_session`.
//
// CLAVE: `maxAge` (cookie PERSISTENTE). Sin él, h3 emite una session-cookie que
// se pierde cuando el webview de la PWA se recicla — p.ej. al abrir un adjunto que
// redirige cross-origin a Tigris (/api/attachment → 302). Al volver, `me()` daba
// null → login → SSO con `ts` bfcache-stale → "Solicitud expirada" → te sacaba.
//
// TODOS los `useSession({name:"gc_session"})` DEBEN usar esto: h3 re-emite el
// Set-Cookie en cada lectura de sesión, así que un solo call site con los defaults
// (sin maxAge) revertiría la persistencia. Un solo lugar = consistencia garantizada.
const MAX_AGE = 60 * 60 * 24 * 30; // 30 días (segundos): TTL del seal y de la cookie.

export function sessionConfig() {
  return {
    password: process.env.SESSION_SECRET!,
    name: "gc_session",
    maxAge: MAX_AGE,
    cookie: {
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "lax" as const,
      maxAge: MAX_AGE,
    },
  };
}
