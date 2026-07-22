import { useEffect } from 'react'
import { HeadContent, Scripts, createRootRoute, redirect } from '@tanstack/react-router'

import '../styles.css'
import { cachedMe } from '../server/auth'
// Engancha `beforeinstallprompt` en module-scope (antes de hidratar) para no
// perder el evento — lo consume InstallAppBanner.
import { registerSW } from '../utils/pwa-install'
import { InstallAppBanner } from '../components/InstallAppBanner'
import { LocaleProvider, DEFAULT_LOCALE } from '../i18n'
import { THEME_BOOT, watchSystemScheme } from '../utils/theme'

export const Route = createRootRoute({
  // Guard: todo requiere sesión, salvo el login y las invitaciones.
  beforeLoad: async ({ location }) => {
    // Guard de tenant (solo SSR → barato, sin round-trips en cada nav de cliente):
    // si caes en el subdominio de un workspace que ya no existe (borrado) o del que
    // el resolver no sabe, te mandamos al PORTAL en vez de un shell roto / label
    // fantasma. Aplica también a /login y /join (en un ws muerto no sirven).
    if (typeof window === 'undefined') {
      const { tenantStatusFn } = await import('../server/workspaces')
      const st = await tenantStatusFn()
      if (!st.ok) throw redirect({ href: `${st.portal}/app` })
    }
    if (location.pathname === '/login' || location.pathname.startsWith('/join')) {
      return { user: null }
    }
    // cachedMe: instantáneo en el cliente (revalida en background) → volver de
    // /settings no espera la red. En SSR va fresco.
    const user = await cachedMe()
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
        href: '/manifest.webmanifest',
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
        </LocaleProvider>
        <Scripts />
      </body>
    </html>
  )
}
