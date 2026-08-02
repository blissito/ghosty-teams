// ── La firma de un texto: invalidación por CONTENIDO ─────────────────────────
//
// Un truco pequeño que resuelve un problema grande y aparece ya en tres sitios: el caché
// de audio del servidor, la cola de la lectura en voz alta y ahora los hallazgos de
// ortografía. La idea es siempre la misma: si lo que se guarda va llaveado por el TEXTO y
// no por la posición ni por el id del bloque, editar invalida solo, sin una línea de
// invalidación que alguien pueda olvidarse de escribir el día que toque el editor.
//
// Isomorfo y sin dependencias: lo usan el cliente (para saber si un hallazgo caducó) y el
// servidor (para sellar lo que envía). Tienen que dar lo mismo, así que vive en un módulo
// y no copiado en dos.
//
// No es criptográfica ni lo pretende: sólo tiene que DISTINGUIR dos textos.

/** djb2. Corta, estable y suficiente para decir "esto ya no es lo que era". */
export function firmaTexto(texto: string): string {
  let h = 5381;
  for (let i = 0; i < texto.length; i++) h = ((h << 5) + h + texto.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
