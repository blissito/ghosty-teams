// DOMParser del SERVER para las utilidades de artefactos (stampIds/nodeIndex/applyPatches).
// Node no trae DOMParser global; jsdom ya es dependencia del repo. Se instancia UNA vez
// (crear un JSDOM por turno es caro) y se reusa: `parseFromString` devuelve documentos
// independientes, así que compartir el parser es seguro.
import type { ParseOpts } from "../lib/artifact-ids";

let cached: ParseOpts["parser"] | null = null;

export async function serverParseOpts(): Promise<ParseOpts> {
  if (!cached) {
    const { JSDOM } = await import("jsdom");
    const { window } = new JSDOM("");
    cached = new window.DOMParser();
  }
  return { parser: cached! };
}
