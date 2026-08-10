/**
 * EXTENSIÓN de un documento: palabras y cuartillas.
 *
 * Por qué existe: el agente afirmaba extensiones que no podía observar. Medido el
 * 2026-08-10 en un trabajo académico real (hilo de @ghosty, mensajes 1819-1824): pidieron
 * "máximo 4 cuartillas", el agente entregó "unas 4", luego "unas 6", y al pedirle volver a
 * 4 recortó al HALF — el resultado final quedó más corto que su primera versión y al
 * imprimir daba 4 páginas incompletas. Nunca contó nada: estimó a ojo las tres veces.
 *
 * Por qué se CUENTA y no se renderiza: la cuartilla es una unidad de conteo, no de layout
 * — está definida como ~250 palabras (Times 12, márgenes de 2.5 cm, interlineado 1.5) o
 * 20-25 líneas. Es también lo que hace la industria editorial: palabras ÷ palabras-por-
 * página, calibrando el divisor UNA vez contra una página real del diseño. Renderizar para
 * contar (LibreOffice headless, Chromium) sólo hace falta cuando el formato no ofrece otra
 * vía —un .docx no sabe cuántas páginas tiene sin motor de layout— y ahí es caro y lento.
 * Aquí tenemos el markdown fuente, así que el camino barato es el correcto.
 *
 * ⚠️ Esto NO es el número de páginas del PDF. Si alguien pide "N páginas" del documento
 * maquetado, eso se mide renderizando (`api.doc-pdf` → render-svc). Son unidades distintas
 * y confundirlas es prometer precisión que este conteo no tiene.
 */

/** Palabras por cuartilla: carta, Times/Arial 12, márgenes 2.5 cm, interlineado 1.5. */
export const WORDS_PER_PAGE = 250;

export type DocExtent = {
  words: number;
  /** Cuartillas, con un decimal. */
  pages: number;
};

/**
 * Cuenta las palabras del CUERPO en prosa. Se descuenta lo que no ocupa renglones de texto
 * corrido —bloques de código, las URLs de los enlaces, la sintaxis de markdown— porque son
 * caracteres que el lector no lee como palabras y que inflarían la cuenta justo en los
 * documentos con más marcado.
 */
export function measureExtent(md: string): DocExtent {
  const prose = (md ?? "")
    // Bloques de código y HTML horneado: no son cuerpo del documento.
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    // Imágenes: no aportan palabras (el alt no se lee en la hoja).
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    // Enlaces: se queda el texto visible, se va la URL.
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    // Marcado que no se pronuncia.
    .replace(/[#*_>`~|]/g, " ")
    .trim();

  const words = prose ? prose.split(/\s+/).filter(Boolean).length : 0;
  return { words, pages: Math.round((words / WORDS_PER_PAGE) * 10) / 10 };
}

/** Una línea lista para inyectar en el contexto del turno. Vacía si no hay cuerpo. */
export function extentLine(md: string): string {
  const { words, pages } = measureExtent(md);
  if (!words) return "";
  return (
    `EXTENSIÓN MEDIDA de este documento: ${words} palabras ≈ ${pages} cuartillas ` +
    `(a ${WORDS_PER_PAGE} palabras por cuartilla). Es un conteo real, no una estimación: ` +
    `úsalo si te piden ajustar la extensión, y no contradigas este número a ojo. ` +
    // El dato viaja en TODOS los turnos con documento, pero casi nunca viene al caso: sin
    // esta línea el agente cerraría sus respuestas informando cuartillas que nadie pidió.
    // Es dato disponible, no tema de conversación.
    `Si nadie preguntó por la extensión, NO lo menciones — es sólo un dato que tienes a mano.`
  );
}
