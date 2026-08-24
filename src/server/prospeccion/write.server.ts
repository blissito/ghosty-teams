/**
 * Columnas escritas por el AGENTE — el paso "escribir" del loop.
 *
 * Una columna de tipo `ai` es una petición por fila: "escribe una primera línea para este
 * negocio, mencionando su giro". El agente la resuelve con las columnas anteriores como
 * contexto, y el resultado queda EN LA TABLA, no en un chat.
 *
 * Que el resultado viva en la tabla es lo que hace útil esta forma frente a pedírselo por
 * el chat: se puede revisar de un vistazo, corregir a mano la que no convenza, y volver a
 * correr sólo lo que falta. Un chat con 100 mensajes redactados no se revisa.
 *
 * ⚠️ Se manda UNA petición por fila y en serie con concurrencia baja, no un turno gigante
 * con las 100 filas: un turno largo se compacta y empieza a mezclar negocios, y si revienta
 * a la mitad se pierde todo. Fila por fila, lo que ya salió se queda.
 */
import { listRows, setCell, type ProspRow } from "./lists.server";
import { matches, type Filter } from "../../lib/prospeccion-filter";

/** El contexto de una fila, tal como se le entrega al agente. */
function rowContext(row: ProspRow, columnLabels: Record<string, string>): string {
  const lines: string[] = [];
  if (row.name) lines.push(`Negocio: ${row.name}`);
  if (row.category) lines.push(`Giro: ${row.category}`);
  if (row.address) lines.push(`Dirección: ${row.address}`);
  if (row.website) lines.push(`Sitio: ${row.website}`);
  if (row.phone) lines.push(`Teléfono: ${row.phone}`);
  for (const [k, cell] of Object.entries(row.data ?? {})) {
    if (cell?.v) lines.push(`${columnLabels[k] ?? k}: ${cell.v}`);
  }
  return lines.join("\n");
}

/**
 * El prompt que envuelve la petición del usuario.
 *
 * Es estricto a propósito con el formato de salida: lo que devuelva va DIRECTO a una celda
 * de tabla. Un preámbulo ("Claro, aquí tienes:") o un bloque de markdown convierten la
 * columna en basura, y son justo lo que un modelo hace por defecto al conversar.
 */
/** Qué se le pide al agente: redactar un texto, o averiguar un hecho. */
export type AiMode = "write" | "research";

const SALIDA = [
  "REGLAS DE SALIDA (obligatorias):",
  "- Responde SÓLO el valor de la celda. Nada de preámbulos, comillas ni markdown.",
  "- Una sola línea, sin saltos.",
];

/**
 * El prompt cambia según el trabajo, y la diferencia NO es cosmética.
 *
 * **Escribir** un texto es generativo: no hay respuesta correcta, y una frase inventada es
 * exactamente lo que se pidió.
 *
 * **Buscar** un dato es lo contrario: hay UNA respuesta correcta y el modelo no la tiene.
 * Tiene que salir a buscarla, y si no la encuentra **el silencio vale más que un invento**
 * — un teléfono inventado no se ve inventado, se ve como un teléfono, y alguien lo va a
 * marcar. Por eso las reglas de esa rama son duras y repetidas: es el único sitio de todo
 * el módulo donde una alucinación acaba en un dato que alguien usa.
 */
/** Alias exportado para el smoke: el contrato del prompt es lo que impide un dato inventado. */
export const buildPromptForTest = (i: string, c: string, m: AiMode) => buildPrompt(i, c, m);

function buildPrompt(instruction: string, context: string, mode: AiMode): string {
  if (mode === "research") {
    return [
      "Vas a AVERIGUAR un dato de un negocio real y ponerlo en UNA celda de una tabla.",
      "",
      "DATOS QUE YA TENEMOS DE ESTE NEGOCIO:",
      context || "(sin datos)",
      "",
      "QUÉ HAY QUE AVERIGUAR:",
      instruction,
      "",
      "CÓMO:",
      "- Búscalo de VERDAD: mira su sitio web, búscalo en internet, entra a sus redes.",
      "- Usa los datos de arriba para no confundirlo con otro negocio del mismo nombre.",
      "",
      "⚠️ LO MÁS IMPORTANTE:",
      "- Si NO lo encuentras, contesta exactamente: —",
      "- NUNCA lo deduzcas, lo aproximes ni lo inventes. Un dato inventado no parece",
      "  inventado: parece un dato, y alguien lo va a usar. Es peor que una celda vacía.",
      "- Si encuentras algo PARECIDO pero no estás seguro de que sea este negocio, contesta —",
      "",
      ...SALIDA,
    ].join("\n");
  }

  return [
    "Vas a ESCRIBIR el texto de UNA celda de una tabla de prospección.",
    "",
    "DATOS DE ESTE NEGOCIO:",
    context || "(sin datos)",
    "",
    "LO QUE HAY QUE ESCRIBIR:",
    instruction,
    "",
    ...SALIDA,
    "- Si los datos no alcanzan para escribirlo, contesta exactamente: —",
  ].join("\n");
}

/** Limpia lo que el modelo devolvió para que quepa en una celda. */
export function cleanCellValue(raw: string): string | null {
  let v = (raw ?? "")
    .replace(/```[\s\S]*?```/g, " ")   // bloques de código
    .replace(/<internal>[\s\S]*?<\/internal>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Comillas envolventes: el modelo las pone aunque se le pida que no.
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("«") && v.endsWith("»"))) {
    v = v.slice(1, -1).trim();
  }
  if (!v || v === "—" || v === "-") return null;
  return v.slice(0, 600);
}

export type WriteProgress = { done: number; total: number; filled: number };

export async function runAiColumn(args: {
  listId: number;
  key: string;
  instruction: string;
  /** `write` redacta; `research` averigua un hecho y calla si no lo encuentra. */
  mode?: AiMode;
  agentHandle?: string | null;
  /** La VISTA. Aquí importa el doble: cada fila es un turno de agente que se factura. */
  filter?: Filter;
  fields?: string[];
  /** Sólo las primeras N de la vista. «Pruébalo con 10» es el primer movimiento de todos. */
  limit?: number;
  invokerSub: string;
  origin?: string;
  concurrency?: number;
  onProgress?: (p: WriteProgress) => void;
}): Promise<WriteProgress & { error?: string }> {
  const { resolvedAgents, callAgentBackendStream } = await import("../../agents.server");
  const { listColumns } = await import("./lists.server");

  const agents = await resolvedAgents();
  const agent = args.agentHandle
    ? agents.find((a) => a.handle === args.agentHandle)
    : agents[0];
  if (!agent) return { done: 0, total: 0, filled: 0, error: "No hay ningún agente activo en este workspace" };

  const columnLabels = Object.fromEntries((await listColumns(args.listId)).map((c) => [c.key, c.label]));
  const todas = await listRows(args.listId);
  const filtradas = args.filter?.length
    ? todas.filter((r) => matches(r as unknown as Record<string, unknown>, args.filter!, args.fields ?? []))
    : todas;
  const rows = args.limit && args.limit > 0 ? filtradas.slice(0, args.limit) : filtradas;
  const queue = [...rows];
  let done = 0;
  let filled = 0;

  // Concurrencia baja: cada fila es un turno de agente y cuestan tokens de verdad.
  const workers = Array.from({ length: Math.min(args.concurrency ?? 3, 6) }, async () => {
    for (;;) {
      const row = queue.shift();
      if (!row) return;

      const existing = row.data[args.key];
      // Lo escrito a mano no se pisa, igual que en el enriquecimiento.
      if (existing?.src === "manual" && existing.v) { done++; args.onProgress?.({ done, total: rows.length, filled }); continue; }

      let out = "";
      try {
        await callAgentBackendStream(
          agent,
          // Un groupId propio POR FILA: si compartieran conversación, la fila 40 llegaría
          // con las 39 anteriores en el contexto y el modelo empezaría a mezclarlas.
          `prosp:${args.listId}:${args.key}:${row.id}`,
          "Prospección",
          buildPrompt(args.instruction, rowContext(row, columnLabels), args.mode ?? "write"),
          (chunk) => { out += chunk; },
          [],
          undefined,
          null,
          args.invokerSub,
          undefined,
          null,
          false,
          args.origin
        );
      } catch (e) {
        out = "";
        console.warn("[prospeccion] fila", row.id, String(e).slice(0, 120));
      }

      const value = cleanCellValue(out);
      await setCell(row.id, args.key, value, { src: `agente:${agent.handle}`, verified: false });
      if (value) filled++;
      done++;
      args.onProgress?.({ done, total: rows.length, filled });
    }
  });

  await Promise.all(workers);
  return { done, total: rows.length, filled };
}
