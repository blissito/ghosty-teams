// ── Del offset de un hallazgo al RANGO del DOM ───────────────────────────────
//
// El corrector devuelve `offset`/`length` sobre el texto del bloque tal y como lo produce
// `blockTextMapped` (runs concatenados, espacios colapsados, trim). Para subrayar la
// palabra hay que encontrarla en la pantalla, y ahí no hay offsets: hay nodos de texto.
//
// Este módulo recorre los nodos de texto del bloque aplicando LA MISMA normalización, y va
// anotando de qué nodo y posición sale cada carácter emitido. Con eso, un offset se
// convierte en un `Range`, y un `Range` sabe dar sus rectángulos — en plural, porque una
// palabra al final de la línea se parte en dos y un solo rectángulo la dibujaría cruzando
// media pantalla.

/**
 * Los nodos de texto del PROPIO bloque, sin los de sus bloques hijos.
 *
 * Un elemento de lista con sub-elementos anida otros `[data-id]` dentro del suyo; si se
 * cuenta su texto, los offsets del padre se desplazan y el subrayado acaba en otra palabra.
 */
function nodosDeTexto(bloque: HTMLElement): Text[] {
  const out: Text[] = [];
  // ⚠️ Se compara el VALOR del `data-id`, no la identidad del elemento. BlockNote repite
  // el atributo en más de un nivel del mismo bloque (el contenedor y el que lleva el
  // contenido), así que exigir `closest(...) === bloque` rechazaba TODOS los nodos de
  // texto: cero posiciones, ningún rango, ni un subrayado. Y desde fuera se veía igual
  // que si el cálculo estuviera mal.
  const mio = bloque.getAttribute("data-id");
  const walker = document.createTreeWalker(bloque, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      // ¿Pertenece a un bloque ANIDADO (otro id)? Entonces no es nuestro.
      const dueño = n.parentElement?.closest("[data-id]");
      const id = dueño?.getAttribute("data-id");
      return !id || id === mio ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

/** Posición de cada carácter del texto normalizado dentro del DOM. */
function posiciones(bloque: HTMLElement): { node: Text; i: number }[] {
  const crudo: { node: Text; i: number; c: string }[] = [];
  for (const node of nodosDeTexto(bloque)) {
    const t = node.data;
    for (let i = 0; i < t.length; i++) crudo.push({ node, i, c: t[i] });
  }
  // Misma normalización que `blockTextMapped`: colapsar espacios y recortar los extremos.
  const norm: { node: Text; i: number }[] = [];
  let ultimoFueEspacio = false;
  for (const p of crudo) {
    if (/\s/.test(p.c)) {
      if (ultimoFueEspacio) continue;
      ultimoFueEspacio = true;
      norm.push({ node: p.node, i: p.i });
      continue;
    }
    ultimoFueEspacio = false;
    norm.push({ node: p.node, i: p.i });
  }
  // trim
  let a = 0;
  let z = norm.length;
  const esEspacio = (k: number) => /\s/.test(norm[k].node.data[norm[k].i]);
  while (a < z && esEspacio(a)) a++;
  while (z > a && esEspacio(z - 1)) z--;
  return norm.slice(a, z);
}

/**
 * El `Range` que cubre `[offset, offset+length)` del texto del bloque, o `null` si el DOM
 * no tiene tantos caracteres — que pasa cuando el documento en pantalla ya no es el que se
 * revisó. Devolver `null` y no señalar nada es lo correcto ahí: subrayar por aproximación
 * apuntaría a una palabra inocente.
 */
export function rangoEnBloque(bloque: HTMLElement, offset: number, length: number): Range | null {
  if (length <= 0) return null;
  const pos = posiciones(bloque);
  const ini = pos[offset];
  const fin = pos[offset + length - 1];
  if (!ini || !fin) return null;
  const r = document.createRange();
  try {
    r.setStart(ini.node, ini.i);
    r.setEnd(fin.node, fin.i + 1);
  } catch {
    return null;
  }
  return r;
}
