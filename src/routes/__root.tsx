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
