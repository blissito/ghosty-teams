import { useEffect, useState } from 'react'
import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

// Purga los caches de sessionStorage (`gc-caches-*`). Un cache envenenado —datos de
// hilo serializados por una versión del app y re-renderizados por otra tras un
// deploy— provoca un mismatch de hidratación que cae SIEMPRE aquí; sin purgar, el
// botón "Recargar" re-restaura el MISMO cache → loop infinito de error (incidente
// 2026-07-09, el usuario tuvo que borrar datos del sitio a mano). Purgar aquí hace
// que la recarga se auto-cure. Barremos cualquier `gc-caches-v*` (no solo la actual).
function purgePoisonedCaches() {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i)
      if (k && k.startsWith('gc-caches-')) sessionStorage.removeItem(k)
    }
  } catch {
    /* sessionStorage inaccesible → nada que purgar */
  }
}

// Guard anti-loop COMPARTIDO: devuelve true si todavía se puede auto-recargar (máx 3
// intentos en 30s) y consume un intento. Lo usan el AppError y el listener de chunks
// stale — si cada uno llevara su propio contador, dos fallos encadenados darían 6
// recargas.
export function puedeAutoRecargar(): boolean {
  const now = Date.now()
  let n = 0, t = 0
  try {
    const p = JSON.parse(sessionStorage.getItem('gc-resume') || '{}')
    n = p.n || 0; t = p.t || 0
  } catch { /* sessionStorage inaccesible */ }
  if (t && now - t > 30_000) { n = 0; t = 0 } // ventana expiró (>30s sin error) → reset
  if (n >= 3) return false
  try { sessionStorage.setItem('gc-resume', JSON.stringify({ n: n + 1, t: t || now })) } catch {}
  return true
}

// Chunk stale tras un deploy: la pestaña lleva el HTML del build ANTERIOR y sus hashes ya
// no existen en el servidor, así que el primer `import()` perezoso que toque (p.ej. el
// resaltado de código al abrir un hilo con un bloque) falla. No es un bug de datos y no se
// cura navegando: sólo recargando, que trae el HTML nuevo con los hashes nuevos.
// Vite emite este evento por nosotros; sin escucharlo el fallo caía en un boundary de
// render y se quedaba en "Algo en esta vista se atoró" para siempre (2026-07-31).
if (typeof window !== 'undefined') {
  window.addEventListener('vite:preloadError', (e) => {
    e.preventDefault() // si no, Vite deja que el error siga y tumbe el árbol antes de recargar
    if (puedeAutoRecargar()) window.location.reload()
  })
}

/** ¿El error es un chunk que ya no existe (deploy nuevo), no un fallo de datos? */
export function esChunkStale(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err ?? '')
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported/i.test(m)
}

// Error component amigable (reemplaza el "Something went wrong!" default de TanStack).
// Estilos inline por robustez: si el fallo fue de render/CSS, no dependemos de Tailwind.
// Invita a recargar — la mayoría de los errores transitorios (red, hidratación) se van
// con un refresh; al montar PURGAMOS el cache para que la recarga arranque limpia.
function AppError() {
  // El 99% de estos errores = caja suspendida (el load de ruta falla mientras despierta);
  // el reload la reanuda server-side. Auto-reanudamos SIN esperar el clic, con guard
  // anti-loop: si un error PERSISTE (bug real / caja caída), auto-reload sin tope sería
  // un loop infinito → máx 3 intentos en 30s; si persiste, caemos al botón manual.
  const [manual, setManual] = useState(false)
  useEffect(() => {
    purgePoisonedCaches()
    if (!puedeAutoRecargar()) { setManual(true); return } // topó el guard → esperar clic
    const id = setTimeout(() => window.location.reload(), 800)
    return () => clearTimeout(id)
  }, [])
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
      <div style={{ fontSize: '44px' }}>💤</div>
      <h1 style={{ fontSize: '20px', fontWeight: 700, margin: 0 }}>El asistente se tomó una pausa</h1>
      <p style={{ margin: 0, maxWidth: '360px', color: '#a1a1aa', lineHeight: 1.5 }}>
        {manual
          ? 'Reintentamos varias veces sin éxito. No se perdió nada — reanuda manualmente.'
          : 'Reanudando justo donde estabas… no se perdió nada.'}
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
        {manual ? 'Reanudar' : 'Reanudar ahora'}
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
