// Apagado ordenado del proceso.
//
// El hot-deploy tardaba ~90s y acababa en SIGKILL: `ghosty-teams.service: State
// 'stop-sigterm' timed out. Killing.` Durante esos 90s el servicio está CAÍDO, y una
// descarga o un turno que caiga en esa ventana falla con un error genérico y sin rastro en
// el log — le pasó al usuario el 2026-07-29 con un .docx.
//
// Node no sale mientras algo retenga su event loop, y aquí lo que lo retenía eran las
// conexiones SSE de `/api/stream`: una por pestaña abierta, sin registrar en ningún sitio,
// así que nadie podía cerrarlas. Mientras alguien tenga Teams abierto, el proceso no muere.
//
// (Los `setInterval` largos —tick de recordatorios, reaper de quick-calls— NO son el
// problema: los dos ya hacen `unref?.()`. Se comprobó porque parecían candidatos.)
//
// Cerrar los SSE de golpe habría sido inaceptable antes de hoy —dejaba a todos sin
// actualizaciones hasta refrescar a mano— pero el cliente ya reconecta solo con backoff
// (`useLiveStream`), así que ahora es seguro.

type Cierre = () => void;

const cierres = new Set<Cierre>();
let armado = false;
let apagando = false;

/**
 * Registra algo que hay que cerrar para que el proceso pueda morir. Devuelve la función
 * para darse de baja (llamarla cuando el recurso se cierre por su cuenta).
 */
export function alApagar(fn: Cierre): () => void {
  cierres.add(fn);
  armar();
  return () => cierres.delete(fn);
}

/** ¿Se está apagando? Los caminos que abren recursos nuevos deben rendirse. */
export function seEstaApagando(): boolean {
  return apagando;
}

function armar(): void {
  if (armado || typeof process === "undefined") return;
  armado = true;
  for (const señal of ["SIGTERM", "SIGINT"] as const) {
    process.once(señal, () => {
      if (apagando) return;
      apagando = true;
      const n = cierres.size;
      for (const fn of cierres) {
        try {
          fn();
        } catch {
          /* cerrar no puede impedir cerrar el resto */
        }
      }
      cierres.clear();
      console.log(`[shutdown] ${señal}: ${n} recurso(s) cerrado(s)`);
      // No se llama a process.exit(): con los recursos liberados, Node sale solo cuando
      // termina lo que tenga a medias (una request en vuelo se completa). Un exit() aquí
      // cortaría esa request, que es justo el error genérico que queríamos quitar.
      // La red es el timeout de systemd, que ya no debería llegar a dispararse.
    });
  }
}
