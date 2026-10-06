// Partes del plan de la fábrica para pintarlo legible en su tarjeta: el `# título` ya va en el
// encabezado (se quita para no repetirlo) y «Listo cuando» se destaca aparte, arriba.

export function splitPlan(planMd: string): { done: string | null; body: string } {
  const lines = planMd.replace(/\r\n/g, "\n").split("\n");
  // El primer renglón con contenido, si es un H1, es el título del pedido.
  const first = lines.findIndex((l) => l.trim() !== "");
  if (first >= 0 && /^#\s+\S/.test(lines[first])) lines.splice(first, 1);
  let done: string | null = null;
  const i = lines.findIndex((l) => /^\s*\*\*listo cuando:?\*\*:?\s*/i.test(l));
  if (i >= 0) {
    done = lines[i].replace(/^\s*\*\*listo cuando:?\*\*:?\s*/i, "").trim() || null;
    lines.splice(i, 1);
  }
  return { done, body: lines.join("\n").trim() };
}

/** Cuántos criterios y pasos trae el plan (para el resumen de la tarjeta cerrada). */
export function planStats(body: string): { criteria: number; steps: number } {
  let section = "";
  let criteria = 0;
  let steps = 0;
  for (const line of body.split("\n")) {
    const h = /^#{1,4}\s+(.+)$/.exec(line);
    if (h) {
      section = h[1].toLowerCase();
      continue;
    }
    if (/criterios/.test(section) && /^\s{0,1}[-*]\s+\S/.test(line)) criteria++;
    if (/pasos|brief/.test(section) && /^\s{0,1}(\d+[.)]|[-*])\s+\S/.test(line)) steps++;
  }
  return { criteria, steps };
}
