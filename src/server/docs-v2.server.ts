// Interruptor de lo nuevo de documentos (7-oct): sugerencias por bloque sobre lo que editó una
// persona, observaciones ancladas (```eb-comment```) y la regla del prompt que las pide.
//
// Por espacio y no global porque la regla del prompt toca TODOS los turnos de documentos y con
// un agente real todavía no está probada. `GT_DOCS_V2_NAMESPACES` = lista separada por comas, o
// `*` para todos. Sin la variable: apagado, y el camino de siempre queda intacto.
export async function docsV2On(): Promise<boolean> {
  const raw = (process.env.GT_DOCS_V2_NAMESPACES ?? "").trim();
  if (!raw) return false;
  if (raw === "*") return true;
  const { currentNamespace } = await import("./tenant.server");
  const ns = await currentNamespace().catch(() => "");
  return raw.split(",").map((s) => s.trim()).includes(ns);
}
