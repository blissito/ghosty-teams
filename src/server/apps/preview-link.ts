// La llave de la preview privada (`?k=`) NO se guarda ni se publica (auditoría del 17-nov): quien lea
// el PR, el hilo o la base obtenía una liga que abre la preview sin pasar por gs. Aquí vive todo lo
// puro: quitarla de una URL o de un texto, y armar la liga estable de Teams (`/preview/<id>`), que
// pide la llave a gs en el momento de abrir, sólo a quien ve el room.

/** La liga sin su llave (`k`). Un texto que no es URL vuelve igual. */
export function stripPreviewKey(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    u.searchParams.delete("k");
    return u.toString();
  } catch {
    return String(url).replace(/([?&])k=[^&#\s)]*&?/g, (_m, sep) => (sep === "?" ? "?" : "")).replace(/[?&]$/, "");
  }
}

/** ¿La liga trae llave? */
export function hasPreviewKey(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).searchParams.has("k");
  } catch {
    return /[?&]k=/.test(String(url));
  }
}

/** Quita `?k=…` de todo un texto (mensajes viejos, resúmenes): sólo en ligas de previews de caja. */
export function scrubPreviewKeys(text: string): string {
  return text.replace(/(https?:\/\/[^\s)\]]*?)([?&])k=[A-Za-z0-9_-]{6,}(&[^\s)\]]*)?/g, (_m, base: string, sep: string, rest?: string) =>
    rest ? `${base}${sep}${rest.slice(1)}` : base,
  );
}

/** Pone la llave a una liga que no la trae (al abrirla). */
export function withPreviewKey(url: string, key: string): string {
  const u = new URL(url);
  u.searchParams.set("k", key);
  return u.toString();
}

/** La liga estable para abrir la preview de un pedido: relativa en la app, absoluta hacia GitHub. */
export function previewOpenPath(runId: number, origin?: string | null): string {
  return `${origin ? origin.replace(/\/+$/, "") : ""}/preview/${runId}`;
}
