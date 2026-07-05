import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    // Preload al hover y REUSA lo precargado al hacer clic (no refetch) → nav instantáneo.
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 30_000,
    // Data del canal fresca 5s → cambiar de canal rápido es instantáneo.
    defaultStaleTime: 5_000,
  })

  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
