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
    const { getMessageBase, getSignatureBusiness } = await import("./sender.server");
    const empresa = (await getSignatureBusiness()) || kit?.name || null;
    const nombre = sender.name || (await getUserName(bySub)) || empresa || "quien manda";
    const base = await getMessageBase();
    return [
      ...(base ? ["MENSAJE BASE ACORDADO CON EL EQUIPO (respeta su oferta, tono y estructura; personaliza, no lo copies tal cual):", `«${base}»`, ""] : []),
      "QUIÉN ESCRIBE Y CÓMO TERMINA EL CORREO:",
      `- Firma: ${nombre}${empresa ? `, de ${empresa}` : ""}. NO escribas la firma: el sistema la pone al final.`,
      `- Cierre: el sistema añade ${describeCta(cta, wa)} justo después de tu texto. NO pidas otra cosa ni`,
      "  repitas ese cierre: tu último párrafo lleva hacia él (qué gana si lo hace).",
      "",
    ].join("\n");
  } catch {
    return "";
  }
}

export type Hallazgos = { angulo: string | null; hechos: { h: string; fuente?: string }[]; no_usar?: string[] };

export function parseHallazgos(raw: string | null | undefined): Hallazgos | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<Hallazgos>;
    if (!o || typeof o !== "object") return null;
    return {
      angulo: typeof o.angulo === "string" && o.angulo.trim() ? o.angulo.trim() : null,
      hechos: Array.isArray(o.hechos) ? o.hechos.filter((x) => x && typeof x.h === "string" && x.h.trim()).map((x) => ({ h: x.h.trim(), fuente: typeof x.fuente === "string" ? x.fuente : undefined })).slice(0, 6) : [],
      no_usar: Array.isArray(o.no_usar) ? o.no_usar.filter((x) => typeof x === "string").slice(0, 10) : [],
    };
  } catch {
    return null;
  }
}

/**
 * Paso 1 del pitch: INVESTIGAR y devolver hallazgos estructurados, no un correo.
 *
 * Es lo que hace la industria (Clay, Smartlead): un trabajo por columna. La investigación
 * queda en su propia celda, legible y podable, y el que escribe no vuelve a la web.
 */
function hallazgosPrompt(instruction: string, context: string): string {
  return [
    "Vas a INVESTIGAR un negocio real para que después OTRO paso le escriba un correo de prospección.",
    "Tú NO escribes el correo: devuelves hallazgos.",
    "",
    "DATOS QUE YA TENEMOS:",
    context || "(sin datos)",
    "",
    "QUÉ OFRECEMOS (para saber qué buscar):",
    instruction,
    "",
    "CÓMO:",
    "- Entra a su sitio web si lo hay, búscalo en internet, mira las redes públicas de la EMPRESA.",
    "- Usa los datos de arriba para no confundirlo con otro negocio del mismo nombre.",
    "- Busca lo que la empresa DICE DE SÍ MISMA: servicios, especialidades, giro, a quién atiende,",
    "  dónde está, desde cuándo. Eso es lo que sirve para elegir el ángulo del correo.",
    "- Lo que NO se usa en un correo frío, porque se siente vigilancia: vacantes, contrataciones,",
    "  reseñas, nombres de socios o empleados, redes personales, noticias de personas, cifras",
    "  internas. Si lo ves, va a `no_usar` (para que el que escribe no lo toque), nunca a `hechos`.",
    "- Nada inventado ni deducido: si no encuentras nada fiable, `angulo: null` y `hechos: []`.",
    "",
    "SALIDA (obligatoria): un JSON entre <hallazgos> y </hallazgos>, y NADA más dentro:",
    '<hallazgos>{"angulo": "una frase: por qué le sirve lo que ofrecemos, dicho como él lo diría", "hechos": [{"h": "lleva auditoría y cumplimiento normativo", "fuente": "https://…"}], "no_usar": ["vacante de agosto"]}</hallazgos>',
    "Máximo 4 hechos, cada uno de una línea. Fuera del bloque puedes narrar lo que quieras: se descarta.",
  ].join("\n");
}

/** Paso 2 del pitch: ESCRIBIR con los hallazgos, sin volver a investigar. */
function correoConHallazgos(instruction: string, context: string, sobre: string, h: Hallazgos | null): string {
  const hechos = h?.hechos.length ? h.hechos.map((x) => `- ${x.h}`).join("\n") : "(no se encontró nada fiable: escribe con los datos de arriba y el mensaje base, sin inventar)";
  return [
    "Vas a ESCRIBIR un correo de prospección para UN negocio real, con lo que ya se investigó.",
    "NO investigues ni uses herramientas: todo lo que necesitas está aquí.",
    "",
    "DATOS DEL NEGOCIO:",
    context || "(sin datos)",
    "",
    `ÁNGULO (por qué le sirve): ${h?.angulo ?? "(sin ángulo claro: usa el del mensaje base)"}`,
    "LO QUE SABEMOS DE LA EMPRESA (contexto, no para citar):",
    hechos,
    ...(h?.no_usar?.length ? [`NO MENCIONES (se siente vigilancia): ${h.no_usar.join("; ")}`] : []),
    "",
    ...(sobre ? [sobre] : []),
    "QUÉ MENSAJE HAY QUE ESCRIBIR:",
    instruction,
    "",
    "CÓMO:",
    "- El ángulo decide el primer párrafo. Los hechos son para que suene a que le hablas a ÉL,",
    "  nunca como prueba de que lo investigaste: nada de «vi que…», «noté que…», «según su sitio…».",
    "  Bien: «en un despacho que lleva auditoría y cumplimiento…». Mal: «vi que abrieron vacante».",
    "- Respeta la oferta, el tono y la estructura del mensaje base; personaliza, no lo copies tal cual.",
    "- Mismo TRATO que el base (si el base tutea, tuteas; nunca mezcles tú y usted).",
    "- El ÚLTIMO párrafo del base (el cierre, la invitación) va tal cual, siempre: es lo que lleva al botón.",
    "- Máximo 160 palabras. Personaliza sobre todo el primer párrafo; lo demás se acorta antes que alargarse.",
    "- Párrafos cortos con línea en blanco. Sin asunto, sin firma.",
    "- Las **negritas** y los enlaces [texto](https://…) sí se pintan; con mesura. Sin #títulos ni viñetas.",
    "",
    "SALIDA (obligatoria): el correo ENTERO entre <correo> y </correo>. Sólo se guarda lo de dentro.",
  ].join("\n");
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
      "- Usa lo que encontraste para ELEGIR EL ÁNGULO (qué le duele, qué servicio suyo se conecta con lo",
      "  que ofreces), NO para demostrar que investigaste. Nunca escribas «vi que…», «noté que…», «según",
      "  su sitio…», ni cites vacantes, contrataciones, reseñas, redes personales, nombres de empleados,",
      "  ni nada que la persona no diría de sí misma en una primera llamada: se siente vigilancia y",
      "  quema el contacto. Está bien: «en un despacho que lleva auditoría y cumplimiento…». Está mal:",
      "  «vi que en agosto abrieron otra vacante».",
      "- Si no encuentras NADA fiable de este negocio, escribe el mensaje sólo con los datos de",
      "  arriba y NO inventes hechos: un dato inventado en un correo de venta quema el contacto.",
      "- Usa los datos de arriba para no confundirlo con otro negocio del mismo nombre.",
      "",
      "REGLAS DE SALIDA (obligatorias):",
      "- El mensaje va ENTERO entre <correo> y </correo>. Sólo se guarda lo que esté dentro; lo que",
      "  digas fuera (qué buscaste, qué falló) se descarta, así que puedes pensar en voz alta fuera.",
      "- Dentro: sólo el texto del mensaje, listo para mandarse. Sin asunto, sin firma (la pone el sistema).",
      "- Es un correo: sin #títulos ni viñetas. Las **negritas** y los enlaces [texto](https://…) SÍ se pintan; úsalos con mesura.",
      "- Párrafos cortos separados por una línea en blanco.",
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
  // Un primer párrafo que es narración del modelo («Voy a buscar…», «Primero reviso…»)
  // se quita si hay más texto detrás. Le pasó a un pitch: la frase de arranque acabó como
  // primera línea de un correo a un cliente.
  if (opts?.multiline) v = stripNarration(v);
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

/**
 * Quita la narración del modelo al principio de un mensaje («Voy a buscar información
 * real de este despacho antes de escribir.Tus clientes…»). Se aplica al escribir la celda
 * Y al armar el correo: una celda vieja no puede salir así a un cliente.
 */
export function stripNarration(v: string): string {
  const NARRA = /^(voy a|primero|déjame|dejame|antes de (escribir|redactar)|investigo|reviso|busco|permíteme|permiteme|ahora (sí )?(escribo|redacto)|aquí (va|está|tienes)|falla|falló|no pude|intento|intentaré|probando|reintento)\b/i;
  // Primero la frase pegada al párrafo real («…antes de escribir el mensaje.Tus clientes…»):
  // si se quitara el párrafo entero se llevaría también el texto bueno.
  v = v.replace(/^(voy a|primero|déjame|dejame|antes de|permíteme|permiteme|falla|falló|fallo|no pude|no puedo|intento|intentaré|intentare|probando|reintento)[^.!?\n]{0,200}[.!?]\s*/i, "");
  // La firma de la costura: el texto de antes de la herramienta y el de después quedaron
  // pegados sin espacio («…proxy residencial.Tus clientes…»). Prosa real lleva espacio
  // tras el punto; si en los primeros 300 caracteres hay un `.Mayúscula`, lo de antes sobra.
  v = v.replace(/^[^\n]{0,300}?[.!?](?=[A-ZÁÉÍÓÚÑ¿¡])/, "");
  const partes = v.split(/\n\s*\n/);
  if (partes.length > 1 && NARRA.test(partes[0].trim())) v = partes.slice(1).join("\n\n");
  return v.trim();
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
  /** `research` estructurado: la celda guarda JSON de hallazgos. */
  structured?: "hallazgos";
  /** `write` que lee la columna de hallazgos `readsKey` de cada fila. */
  readsKey?: string;
  /** Saltar las filas que ya tienen valor en `key`. */
  onlyEmpty?: boolean;
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
  const estructurado = args.structured === "hallazgos";
  const conHallazgos = !!args.readsKey;
  // Contador aparte: un turno que no devolvió su bloque marcado no es «vacío», es un fallo
  // de formato, y el resumen tiene que decirlo para que no parezca que no había nada.
  let sinBloque = 0;
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
      if (args.onlyEmpty && existing?.v) { done++; filled++; args.onProgress?.({ done, total: rows.length, filled }); continue; }

      let out = "";
      try {
        await callAgentBackendStream(
          agent,
          // Un groupId propio POR FILA: si compartieran conversación, la fila 40 llegaría
          // con las 39 anteriores en el contexto y el modelo empezaría a mezclarlas.
          `prosp:${args.listId}:${args.key}:${row.id}`,
          "Prospección",
          estructurado
            ? hallazgosPrompt(args.instruction, rowContext(row, columnLabels))
            : conHallazgos
              ? correoConHallazgos(args.instruction, rowContext(row, columnLabels), sobre, parseHallazgos(row.data[args.readsKey!]?.v))
              : buildPrompt(args.instruction, rowContext(row, columnLabels), args.mode ?? "write", sobre),
          (chunk) => { out += chunk; },
          [],
          // Lo que el modelo dice ANTES de una herramienta es narración («Voy a buscar…»),
          // no la celda. Cada tool que arranca descarta lo acumulado: la respuesta es lo
          // que viene después de la última.
          (ev) => { if ((ev as { phase?: string } | null)?.phase !== "end") out = ""; },
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
      // El transporte NO lanza cuando el worker muere: escribe «⚠️ No pude contactar a @…»
      // como si fuera texto. En un chat eso es un aviso; en una celda es un correo que dice
      // eso. Se trata como el fallo que es, y la celda queda vacía para volver a correrla.
      if (/⚠️ No pude contactar a @/.test(out)) {
        console.warn("[prospeccion] fila", row.id, "el turno del agente murió:", out.slice(0, 120));
        out = "";
        failed++;
      }

      // Un pitch investigado es un correo entero: varios párrafos y más de 600 letras.
      // El pitch viene marcado: se toma el ÚLTIMO <correo>…</correo> y nada más. Si el
      // modelo no marcó, se cae a la limpieza heurística (que es lo que había antes).
      let value: string | null;
      if (estructurado) {
        const bloque = [...out.matchAll(/<hallazgos>([\s\S]*?)<\/hallazgos>/gi)].at(-1)?.[1];
        const h = parseHallazgos(bloque?.trim() ?? null);
        if (!h) { sinBloque++; value = null; }
        // Nada fiable = celda vacía, no un JSON vacío que parezca un hallazgo.
        else value = h.angulo || h.hechos.length ? JSON.stringify(h) : null;
      } else if (conHallazgos || args.mode === "pitch") {
        const marcado = [...out.matchAll(/<correo>([\s\S]*?)<\/correo>/gi)].at(-1)?.[1];
        if (marcado == null && out.trim()) sinBloque++;
        // Sin bloque: la limpieza heurística de siempre, como respaldo.
        value = cleanCellValue(marcado ?? out, { multiline: true, max: 2500 });
      } else {
        value = cleanCellValue(out);
      }
      // El destino puede ser una columna BASE: «enriquece la Dirección» llena la que ya
      // está, no una gemela.
      await setCell(row.id, args.writesTo || args.key, value, {
        src: `agente:${agent.handle}`,
        verified: false,
      });
      if (value) filled++;
      else if ((!failed || out) && !(estructurado && !value && sinBloque)) blank++;
      done++;
      args.onProgress?.({ done, total: rows.length, filled });
    }
  });

  // Cuenta como turno en vuelo mientras corran las filas: un deploy no debe pisarlo.
  const { countingTurn } = await import("../../agents.server");
  await countingTurn(() => Promise.all(workers));

  // La explicación sólo aparece cuando hace falta — igual que en `runEnrichColumn`: si
  // llenó todo, el número habla solo.
  const partes: string[] = [];
  if (failed) partes.push(`${failed} el turno del agente falló`);
  if (blank) partes.push(`${blank} el agente no encontró el dato`);
  if (sinBloque) partes.push(`${sinBloque} contestó sin el formato pedido`);
  const note = filled < rows.length && partes.length ? partes.join(" · ") : null;
  return { done, total: rows.length, filled, note };
}
