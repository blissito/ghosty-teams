// Una presignada de NUESTRO bucket (`t3.storage.dev/ghosty-teams/<key>?X-Amz-…`) caduca a
// los 7 días: el agente la pega como `![](…)` y el mensaje sale con la imagen rota a la
// semana (banner de la tanda, 30-sep → visto roto el 26-oct). El objeto sigue ahí; sólo
// muere la firma. `/api/attachment/<key>` re-firma en cada visita con la sesión del
// miembro, así que la reescritura no necesita bajar ni re-subir nada.
const OWN_PRESIGNED = /^https:\/\/t3\.storage\.dev\/ghosty-teams\/([^?#]+)\?[^#]*X-Amz-/;

/** La ruta permanente de una presignada propia, o null si la url no es nuestra. */
export function ownStoragePath(url: string | undefined | null): string | null {
  const m = url ? OWN_PRESIGNED.exec(url) : null;
  if (!m) return null;
  try {
    return `/api/attachment/${encodeURIComponent(decodeURIComponent(m[1]))}`;
  } catch {
    return null;
  }
}
