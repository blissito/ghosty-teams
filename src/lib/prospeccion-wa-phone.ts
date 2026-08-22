/**
 * Normalizar un número para un enlace `wa.me`.
 *
 * ⚠️ `wa.me` NO acepta los 10 dígitos sueltos: exige el número completo con lada de país y
 * sin signos. Un `7714460521` produce un enlace que no abre ninguna conversación, y el
 * fallo es mudo — WhatsApp enseña «el número no es válido» al PROSPECTO, no a ti.
 *
 * México es el caso que hay que acertar:
 *  · 10 dígitos (`7714460521`) → se les antepone `52`.
 *  · Con el `1` de móvil que arrastra el formato viejo (`5217714460521`) → se QUITA. Para
 *    enlaces `wa.me` sobra desde 2020 y con él el enlace falla.
 *    (No confundir con el pareo de Baileys, que sí lo exige: ver la memoria del pareo MX.)
 *  · Ya con lada (`527714460521`) → tal cual.
 *
 * Devuelve null si no puede decidir. Mejor no poner botón que poner uno roto.
 */
export function normalizeWaPhone(raw: string): string | null {
  const d = (raw ?? "").replace(/\D/g, "");
  if (!d) return null;

  // México con el 1 de móvil heredado: 52 + 1 + 10 dígitos.
  if (d.length === 13 && d.startsWith("521")) return `52${d.slice(3)}`;
  // México ya normalizado, o cualquier país con 12 dígitos.
  if (d.length === 12 && d.startsWith("52")) return d;
  // Diez dígitos pelones: se asume México, que es el mercado.
  if (d.length === 10) return `52${d}`;
  // Otros países: se acepta si tiene un largo plausible de E.164.
  if (d.length >= 11 && d.length <= 15) return d;
  return null;
}

/** Cómo se enseña el número, para que se pueda cotejar de un vistazo. */
export function prettyWaPhone(normalized: string): string {
  if (normalized.length === 12 && normalized.startsWith("52")) {
    const n = normalized.slice(2);
    return `+52 ${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
  }
  return `+${normalized}`;
}
