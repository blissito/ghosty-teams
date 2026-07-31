// Auto-recarga con guard anti-loop, COMPARTIDA por todo el que quiera curarse recargando.
//
// Vive en su propio módulo (y no en `router.tsx`) porque lo consumen también las rutas, y
// `router.tsx` importa `routeTree.gen` → las rutas: importarlo desde ahí cerraría el ciclo.

/**
 * ¿Se puede auto-recargar? Máx 3 intentos en 30s; cada llamada CONSUME un intento.
 *
 * Un contador por cada sitio que recarga daría 3×N recargas en un fallo encadenado, así que
 * el estado es uno solo (`gc-resume` en sessionStorage). Sin tope, un error que PERSISTE
 * (bug real, caja caída) sería un loop infinito de recargas.
 */
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

/**
 * ¿El error es un chunk que ya no existe (deploy nuevo), y no un fallo de datos?
 *
 * La pestaña lleva el HTML del build ANTERIOR y sus hashes murieron con el deploy (que
 * reemplaza `.output` entero), así que el primer `import()` perezoso que toque revienta.
 * No se cura navegando ni limpiando cache: sólo recargando, que trae el HTML nuevo.
 * El texto del error cambia según el navegador — de ahí las tres alternativas.
 */
export function esChunkStale(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err ?? '')
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported/i.test(m)
}

/**
 * Escucha el evento que Vite emite cuando falla la precarga de un chunk. Sin esto, el fallo
 * caía en un boundary de render y se quedaba en "Algo en esta vista se atoró" para siempre
 * (incidente 2026-07-31: un hilo con un bloque de código dejó de abrirse tras un deploy).
 */
export function escucharChunksStale() {
  if (typeof window === 'undefined') return
  window.addEventListener('vite:preloadError', (e) => {
    e.preventDefault() // si no, Vite deja que el error siga y tumbe el árbol antes de recargar
    if (puedeAutoRecargar()) window.location.reload()
  })
}
