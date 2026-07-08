import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

// Error component amigable (reemplaza el "Something went wrong!" default de TanStack).
// Estilos inline por robustez: si el fallo fue de render/CSS, no dependemos de Tailwind.
// Invita a recargar — la mayoría de los errores transitorios (red, hidratación) se van
// con un refresh, y con la persistencia en sessionStorage el estado se restaura.
function AppError() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '14px',
        padding: '24px',
        textAlign: 'center',
        background: '#0b0b0f',
        color: '#e9e9ee',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <div style={{ fontSize: '44px' }}>👻</div>
      <h1 style={{ fontSize: '20px', fontWeight: 700, margin: 0 }}>Se nos cruzó un cable</h1>
      <p style={{ margin: 0, maxWidth: '360px', color: '#a1a1aa', lineHeight: 1.5 }}>
        Nada grave. Recarga la página y seguimos justo donde estabas.
      </p>
      <button
        onClick={() => window.location.reload()}
        style={{
          marginTop: '6px',
          padding: '10px 22px',
          borderRadius: '10px',
          border: 'none',
          background: '#9870ED',
          color: '#fff',
          fontWeight: 600,
          fontSize: '15px',
          cursor: 'pointer',
        }}
      >
        Recargar
      </button>
    </div>
  )
}

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    // Preload al hover y REUSA lo precargado al hacer clic (no refetch) → nav instantáneo.
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 30_000,
    // Data del canal fresca 5s → cambiar de canal rápido es instantáneo.
    defaultStaleTime: 5_000,
    defaultErrorComponent: AppError,
  })

  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
