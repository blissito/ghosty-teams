import { useEffect } from 'react'
import { HeadContent, Scripts, createRootRoute, redirect } from '@tanstack/react-router'

import '../styles.css'
import { cachedMe } from '../server/auth'
// Engancha `beforeinstallprompt` en module-scope (antes de hidratar) para no
// perder el evento — lo consume InstallAppBanner.
import { registerSW } from '../utils/pwa-install'
import { InstallAppBanner } from '../components/InstallAppBanner'
import { CallLayer } from '../components/CallLayer'
import { LocaleProvider, DEFAULT_LOCALE } from '../i18n'
import { THEME_BOOT, watchSystemScheme } from '../utils/theme'

export const Route = createRootRoute({
  // Guard: todo requiere sesión, salvo el login y las invitaciones.
  beforeLoad: async ({ location }) => {
    // El relay OAuth de conectores corre en el host CENTRAL (oauth.teams.ghosty.studio):
    // sin tenant ni sesión propios (la cookie es por-subdominio del workspace). Exímelo
    // de AMBOS guards, si no rebota a portal/login antes de poder rebotar al subdominio.
    const isOAuthRelay = location.pathname.startsWith('/oauth/')
    // Estáticos: NUNCA son navegación, así que no pasan por ningún guard.
    //
    // Nitro hornea el manifiesto de estáticos en el bundle: un hash que no está ahí (una
    // pestaña abierta ANTES del deploy pidiendo un chunk del build anterior — el deploy
    // reemplaza `.output` entero) no matchea el handler estático y cae al handler SSR, o
    // sea aquí. Sin esta salida temprana el navegador recibía `307 → /login` y HTML donde
    // esperaba JS: `Failed to fetch dynamically imported module`, un error que no se parece
    // en nada a su causa (incidente 2026-07-31, un hilo entero "se atoró" por esto).
    // Con la exención cae al 404 de Nitro, que es lo que el listener de `vite:preloadError`
    // en `router.tsx` sabe interpretar → recarga y se auto-cura.
    if (/^\/(assets\/|_build\/|sw\.js$|favicon\.ico$|manifest\.webmanifest$)/.test(location.pathname)) {
      return { user: null }
    }
    // Ruta demo del editor de lienzo (@ghosty/canvas-editor) — pública, sin tenant/sesión.
    // Bancos de pruebas de editores: sin sesión y sin tenant, porque su razón de ser es
    // depurar con datos sintéticos.
    //
    // `/doc-probe` SÓLO en desarrollo. Se sumó el 2026-07-29 para dejar de depurar el
    // marcado del cambio quirúrgico a base de deploys a producción, y con la exención
    // abierta quedaba respondiendo 200 sin sesión en prod: no filtra nada (el documento es
    // sintético) pero es una ruta pública que nadie pidió, y sirve el bundle del editor a
    // cualquiera.
    const isCanvasDemo =
      location.pathname.startsWith('/canvas-demo') ||
      location.pathname.startsWith('/canvas-probe') ||
      (import.meta.env.DEV && location.pathname.startsWith('/doc-probe')) ||
      // Banco del panel de Marca, misma razón y mismo candado (sólo DEV): el editor vive
      // dentro del modal de Ajustes y ajustarle el layout a base de deploys es justo lo
      // que no queremos volver a hacer.
      (import.meta.env.DEV && location.pathname.startsWith('/brand-probe'))
    // Guard de tenant (solo SSR → barato, sin round-trips en cada nav de cliente):
    // si caes en el subdominio de un workspace que ya no existe (borrado) o del que
    // el resolver no sabe, te mandamos al PORTAL en vez de un shell roto / label
    // fantasma. Aplica también a /login y /join (en un ws muerto no sirven).
    if (typeof window === 'undefined' && !isOAuthRelay && !isCanvasDemo) {
      const { tenantStatusFn } = await import('../server/workspaces')
      const _t = performance.now()
      const st = await tenantStatusFn()
      const _ms = performance.now() - _t
      if (_ms > 200) console.log(`[ssr tenantStatus ${Math.round(_ms)}ms]`)
      if (!st.ok) throw redirect({ href: `${st.portal}/app` })
    }
    // Artefacto compartido (/artefacto/<slug>): público por diseño — lo abre gente sin cuenta.
    // El permiso lo resuelve la propia ruta (resolveSharedArtifact), que responde 404
    // si no es "cualquiera con el enlace" y no eres el dueño. Mandar aquí a /login
    // convertiría cada link compartido en una invitación a registrarse.
    const isSharedArtifact = location.pathname.startsWith('/artefacto/')
    // Co-edición para gente de FUERA (/coeditar/<slug> y /coeditar/invitacion/<token>):
    // igual de pública que el artefacto compartido, y por la misma razón — mandarla a
    // /login convierte cada invitación en una invitación a registrarse. El permiso lo
    // resuelve la propia ruta (el `share_role` del enlace o el token de la invitación) y
    // el nivel viaja FIRMADO en el ticket, así que abrir la puerta aquí no la afloja.
    const isCoedit = location.pathname.startsWith('/coeditar/')
    if (
      isOAuthRelay ||
      isCanvasDemo ||
      isSharedArtifact ||
      isCoedit ||
      location.pathname === '/login' ||
      location.pathname.startsWith('/join')
    ) {
      return { user: null }
    }
    // cachedMe: instantáneo en el cliente (revalida en background) → volver de
    // /settings no espera la red. En SSR va fresco.
    const _t2 = performance.now()
    const user = await cachedMe()
    if (typeof window === 'undefined') {
      const _ms2 = performance.now() - _t2
      if (_ms2 > 200) console.log(`[ssr cachedMe ${Math.round(_ms2)}ms]`)
    }
    if (!user) throw redirect({ to: '/login' })
    return { user }
  },
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1, viewport-fit=cover',
      },
      {
        title: 'Ghosty Teams',
      },
      // Instalable como app (PWA) en mobile y desktop.
      { name: 'theme-color', content: '#7c3aed' },
      { name: 'mobile-web-app-capable', content: 'yes' },
      { name: 'apple-mobile-web-app-capable', content: 'yes' },
      { name: 'apple-mobile-web-app-title', content: 'Ghosty Teams' },
      { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' },
      // Open Graph / Twitter → preview con imagen en WhatsApp, iMessage, etc. (p.ej.
      // al compartir un link de invitación /join/…). Imagen absoluta PNG con
      // dimensiones declaradas (WhatsApp omite la imagen si no puede medirla).
      { name: 'description', content: 'Chat de equipo con @ghosty integrado.' },
      { property: 'og:title', content: 'Ghosty Teams' },
      { property: 'og:description', content: 'Chat de equipo con @ghosty integrado.' },
      { property: 'og:image', content: 'https://www.ghosty.studio/ghosty-og.png' },
      { property: 'og:image:secure_url', content: 'https://www.ghosty.studio/ghosty-og.png' },
      { property: 'og:image:type', content: 'image/png' },
      { property: 'og:image:width', content: '512' },
      { property: 'og:image:height', content: '512' },
      { property: 'og:image:alt', content: 'Ghosty Teams' },
      { property: 'og:type', content: 'website' },
      { property: 'og:site_name', content: 'Ghosty Teams' },
      { name: 'twitter:card', content: 'summary' },
      { name: 'twitter:title', content: 'Ghosty Teams' },
      { name: 'twitter:description', content: 'Chat de equipo con @ghosty integrado.' },
      { name: 'twitter:image', content: 'https://www.ghosty.studio/ghosty-og.png' },
    ],
    links: [
      {
        rel: 'icon',
        type: 'image/svg+xml',
        href: '/ghosty.svg',
      },
      {
        rel: 'apple-touch-icon',
        href: '/apple-touch-icon.png',
      },
      {
        rel: 'manifest',
        href: '/api/manifest', // per-tenant (dinámico) — ver src/routes/api.manifest.ts
      },
      {
        // La marca del workspace, per-tenant. Va como <link> y no dentro del boot script
        // porque una hoja bloquea el render (sin FOUC) y deja que el preset que la
        // persona eligió le gane por especificidad. Ver src/routes/api.brand-css.ts.
        rel: 'stylesheet',
        href: '/api/brand-css',
      },
    ],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  // Registra el service worker (requisito de instalabilidad de Chrome).
  useEffect(() => {
    registerSW()
  }, [])
  // Cuando el scheme es "system", sigue en vivo el cambio de preferencia del SO.
  useEffect(() => watchSystemScheme(), [])
  return (
    <html lang={DEFAULT_LOCALE} suppressHydrationWarning>
      <head>
        {/* Aplica preset+scheme ANTES del primer paint (sin FOUC). El boot script muta
            <html> (data-theme + vars inline) antes de hidratar → suppressHydrationWarning
            evita que React trate esos atributos como mismatch. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        <HeadContent />
      </head>
      <body>
        <LocaleProvider locale={DEFAULT_LOCALE}>
          {children}
          <InstallAppBanner />
          {/* Llamada + avisos de entrante, GLOBALES: RootDocument no se desmonta al
              navegar, así que ir a /forms o a un documento ya no cuelga la llamada. */}
          <CallLayer />
        </LocaleProvider>
        <Scripts />
      </body>
    </html>
  )
}
