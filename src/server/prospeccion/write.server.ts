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
export type AiMode = "write" | "research" | "pitch";

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

/**
 * Quién firma y con qué cierra, dicho al modelo antes de redactar.
 *
 * Sin esto inventaba su propio cierre («¿agendamos una llamada?») y firmaba como «El
 * equipo»: luego la plantilla pegaba el botón real debajo y el correo pedía dos cosas.
 */
async function senderContext(bySub: string | null): Promise<string> {
  try {
    const { getSender, getCta, describeCta } = await import("./sender.server");
    const { getUserName } = await import("./send.server");
    const { getConfig } = await import("../../config.server");
    const { activeBrandKit } = await import("../brand.server");
    const [sender, cta, wa, kit] = await Promise.all([getSender(), getCta(), getConfig("prospeccion_wa_phone"), activeBrandKit().catch(() => null)]);
    const nombre = sender.name || (await getUserName(bySub)) || kit?.name || "quien manda";
    return [
      "QUIÉN ESCRIBE Y CÓMO TERMINA EL CORREO:",
      `- Firma: ${nombre}${kit?.name ? `, de ${kit.name}` : ""}. NO escribas la firma: el sistema la pone al final.`,
      `- Cierre: el sistema añade ${describeCta(cta, wa)} justo después de tu texto. NO pidas otra cosa ni`,
      "  repitas ese cierre: tu último párrafo lleva hacia él (qué gana si lo hace).",
      "",
    ].join("\n");
  } catch {
    return "";
  }
}

function buildPrompt(instruction: string, context: string, mode: AiMode, sobre = ""): string {
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

  if (mode === "pitch") {
    return [
      "Vas a ESCRIBIR un mensaje de prospección para UN negocio real, y antes vas a INVESTIGARLO.",
      "",
      "DATOS QUE YA TENEMOS DE ESTE NEGOCIO:",
      context || "(sin datos)",
      "",
      ...(sobre ? [sobre] : []),
      "QUÉ MENSAJE HAY QUE ESCRIBIR:",
      instruction,
      "",
      "CÓMO:",
      "- Primero investiga de VERDAD: entra a su sitio web si lo hay, búscalo en internet, mira sus",
      "  redes. Busca 1 o 2 hechos CONCRETOS y recientes de ESTE negocio (un servicio que ofrecen,",
      "  una sucursal, una reseña, algo que publicaron, a quién atienden).",
      "- Escribe el mensaje usando esos hechos, de forma natural: que se note que lo leíste, sin",
      "  decir «vi en tu sitio que…» en cada frase.",
      "- Si no encuentras NADA fiable de este negocio, escribe el mensaje sólo con los datos de",
      "  arriba y NO inventes hechos: un dato inventado en un correo de venta quema el contacto.",
      "- Usa los datos de arriba para no confundirlo con otro negocio del mismo nombre.",
      "",
      "REGLAS DE SALIDA (obligatorias):",
      "- Responde SÓLO el texto del mensaje, listo para mandarse. Nada de preámbulos, comillas,",
      "  markdown ni asunto.",
      "- Párrafos cortos separados por una línea en blanco. Sin firma: la pone el sistema.",
    ].join("\n");
  }

  return [
    "Vas a ESCRIBIR el texto de UNA celda de una tabla de prospección.",
    "",
    "DATOS DE ESTE NEGOCIO:",
    context || "(sin datos)",
    "",
    ...(sobre ? [sobre] : []),
    "LO QUE HAY QUE ESCRIBIR:",
    instruction,
    "",
    ...SALIDA,
    "- Si los datos no alcanzan para escribirlo, contesta exactamente: —",
  ].join("\n");
}

/** Limpia lo que el modelo devolvió para que quepa en una celda. */
export function cleanCellValue(raw: string, opts?: { multiline?: boolean; max?: number }): string | null {
  let v = (raw ?? "")
    .replace(/```[\s\S]*?```/g, " ")   // bloques de código
    .replace(/<internal>[\s\S]*?<\/internal>/g, " ")
    .trim();
  // Un mensaje de varios párrafos conserva sus saltos; una celda de dato se aplana.
  v = opts?.multiline
    ? v.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()
    : v.replace(/\s+/g, " ").trim();
  // Comillas envolventes: el modelo las pone aunque se le pida que no.
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("«") && v.endsWith("»"))) {
    v = v.slice(1, -1).trim();
  }
  if (!v || v === "—" || v === "-") return null;
  return v.slice(0, opts?.max ?? 600);
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
  /** Escribir en esta columna base en vez de en `key`. */
  writesTo?: string;
  invokerSub: string;
  origin?: string;
  concurrency?: number;
  onProgress?: (p: WriteProgress) => void;
}): Promise<WriteProgress & { error?: string; note?: string | null }> {
  const { resolvedAgents, callAgentBackendStream } = await import("../../agents.server");
  const { listColumns } = await import("./lists.server");

  const agents = await resolvedAgents();
  const agent = args.agentHandle
    ? agents.find((a) => a.handle === args.agentHandle)
    : agents[0];
  if (!agent) return { done: 0, total: 0, filled: 0, error: "No hay ningún agente activo en este workspace" };

  const columnLabels = Object.fromEntries((await listColumns(args.listId)).map((c) => [c.key, c.label]));
  // Una vez por columna, no por fila: remitente y cierre son del workspace.
  const sobre = (args.mode ?? "write") === "research" ? "" : await senderContext(args.invokerSub ?? null);
  const todas = await listRows(args.listId);
  const filtradas = args.filter?.length
    ? todas.filter((r) => matches(r as unknown as Record<string, unknown>, args.filter!, args.fields ?? []))
    : todas;
  const rows = args.limit && args.limit > 0 ? filtradas.slice(0, args.limit) : filtradas;
  const queue = [...rows];
  let done = 0;
  let filled = 0;
  // ⚠️ Sin esto «0 de 6 llenadas» era TODO lo que se veía, y los dos motivos son
  // opuestos: si el turno del agente REVENTÓ hay que arreglar algo; si contestó vacío
  // es que el dato no existe en la web y no hay nada que arreglar. El camino de
  // enriquecimiento ya explicaba sus saltos; éste no explicaba ninguno.
  let failed = 0;
  let blank = 0;

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
          buildPrompt(args.instruction, rowContext(row, columnLabels), args.mode ?? "write", sobre),
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
        failed++;
        console.warn("[prospeccion] fila", row.id, String(e).slice(0, 120));
      }

      // Un pitch investigado es un correo entero: varios párrafos y más de 600 letras.
      const value = args.mode === "pitch" ? cleanCellValue(out, { multiline: true, max: 2500 }) : cleanCellValue(out);
      // El destino puede ser una columna BASE: «enriquece la Dirección» llena la que ya
      // está, no una gemela.
      await setCell(row.id, args.writesTo || args.key, value, {
        src: `agente:${agent.handle}`,
        verified: false,
      });
      if (value) filled++;
      else if (!failed || out) blank++;
      done++;
      args.onProgress?.({ done, total: rows.length, filled });
    }
  });

  await Promise.all(workers);

  // La explicación sólo aparece cuando hace falta — igual que en `runEnrichColumn`: si
  // llenó todo, el número habla solo.
  const partes: string[] = [];
  if (failed) partes.push(`${failed} el turno del agente falló`);
  if (blank) partes.push(`${blank} el agente no encontró el dato`);
  const note = filled < rows.length && partes.length ? partes.join(" · ") : null;
  return { done, total: rows.length, filled, note };
}
