// Presencia — lo poco que servidor y cliente tienen que compartir.
//
// Vive aquí y no en `bus.server.ts` porque el cliente lo necesita para pintar, y un
// import a un módulo `.server` desde el navegador no es una opción. Duplicar el número
// tampoco: el servidor avisa del regreso a "activo" con este umbral, y si el cliente
// usara otro pintaría a alguien como inactivo sin que nadie le fuera a avisar de vuelta.

/** Sin señal en este rato, la persona deja de contar como activa (sigue conectada). */
export const IDLE_MS = 10 * 60_000;
