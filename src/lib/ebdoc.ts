// Protocolo del artefacto en vivo (OLA 2 — "Canvas"). El agente redacta el artefacto DENTRO
// de un bloque cercado en su respuesta y GTeams lo streamea al panel EN VIVO:
//   ```eb-doc      … ```  → documento de PROSA (Markdown)  → hoja tipo Word, export .docx
//   ```eb-sheet    … ```  → HOJA de cálculo (CSV)           → tabla, export .csv
//   ```eb-artifact … ```  → ARTEFACTO HTML interactivo      → iframe sandbox + publicado a S3
// Al terminar, GTeams lo commitea LOCAL (gc_artifacts.md = la verdad) y al MODIFICAR re-inyecta
// ese contenido al agente para que re-emita el artefacto COMPLETO (misma vía de streaming).
// Funciones PURAS: las usa el cliente (parseo en vivo) y el server (post-step + limpieza).

export type EbDocKind = "doc" | "sheet" | "artifact";

export type EbDoc = {
  kind: EbDocKind; // doc = markdown; sheet = csv; artifact = HTML autocontenido
  before: string; // texto antes del bloque (narración)
  md: string; // el contenido del artefacto (markdown | csv)
  after: string; // texto después del bloque (vacío mientras streamea)
  closed: boolean; // ¿ya llegó el ``` de cierre?
  fenceTitle?: string; // título opcional en la línea de apertura (```eb-sheet Nombre)
  /**
   * El agente declaró que esto es un documento NUEVO (```eb-artifact nuevo Título```),
   * no una versión del que ya hay en el hilo.
   *
   * Existe porque el default es lo contrario: re-emitir el fence completo es cómo se
   * edita un artefacto, así que sin esta marca todo lo que pidiera después caía como
   * versión del anterior — una propuesta comercial entró como "Versión 4" de una
   * comparativa de TTS y su enlace abría el documento equivocado.
   */
  isNew?: boolean;
};

// Extrae el bloque ```eb-doc``` o ```eb-sheet``` del texto. Tolera el fence ABIERTO (aún
// streameando, sin cierre) → toma todo lo que va después de la apertura como el contenido.
export function extractEbDoc(body: string): EbDoc | null {
  // El fence SOLO cuenta si abre una LÍNEA (^```eb-…) y su resto de línea no trae backtick.
  // Si no, la MENCIÓN del protocolo en prosa ("lo pongo en un bloque ```eb-artifact`, y la
  // plataforma lo renderiza…") abría el panel con la charla adentro (reportado 2026-07-25).
  const open = body.match(/(^|\n)```eb-(doc|sheet|artifact)([^\n`]*)\n/);
  if (!open || open.index == null) return null;
  const kind = open[2] as EbDocKind;
  // `nuevo` / `new` como PRIMERA palabra de la cabecera es una marca, no el título.
  const header = (open[3] ?? "").trim();
  const newMark = /^(nuevo|new)\b[:\s-]*/i.exec(header);
  const isNew = !!newMark;
  const fenceTitle = (newMark ? header.slice(newMark[0].length).trim() : header) || undefined;
  const start = open.index + open[0].length;
  const rest = body.slice(start);
  const closeIdx = rest.indexOf("```");
  if (closeIdx === -1) {
    return { kind, before: body.slice(0, open.index), md: rest, after: "", closed: false, fenceTitle, isNew };
  }
  return {
    kind,
    before: body.slice(0, open.index),
    md: rest.slice(0, closeIdx),
    after: rest.slice(closeIdx + 3),
    closed: true,
    fenceTitle,
    isNew,
  };
}

/**
 * ¿Este fence continúa el artefacto del hilo, o empieza otro?
 *
 * Re-emitir el fence completo es a la vez "edítalo" y "hazme otro", así que el server
 * tenía que adivinar y siempre adivinaba lo mismo: versión del anterior. Por eso una
 * propuesta comercial nueva aterrizó como "Versión 4" de una comparativa de TTS, y su
 * enlace compartido abría el documento equivocado.
 *
 * Tres señales, de la más fuerte a la más débil:
 * 1. el agente lo declaró (`nuevo` en la cabecera);
 * 2. cambió el TIPO (una hoja no es una versión de un HTML);
 * 3. para artefactos HTML, no comparte NI UN `data-id` con el actual. Una edición
 *    re-emite el mismo árbol —el agente recibió el documento ya estampado— así que
 *    cero coincidencias significa que esto es otro documento. Sólo se aplica cuando
 *    el actual tiene ids; si no los tiene, no hay señal y se conserva el default.
 */
export function isSameDocument(
  ebdoc: Pick<EbDoc, "kind" | "md" | "isNew">,
  current: { kind: EbDocKind; md: string } | null | undefined
): boolean {
  if (!current) return false;
  if (ebdoc.isNew) return false;
  if (ebdoc.kind !== current.kind) return false;
  if (ebdoc.kind !== "artifact") return true;
  const ids = (s: string) => new Set(Array.from(s.matchAll(/\bdata-id="([^"]+)"/g), (m) => m[1]));
  const cur = ids(current.md);
  const next = ids(ebdoc.md);
  // Hace falta que los DOS lados tengan ids para poder comparar. El agente escribe HTML
  // limpio y los `data-id` se los estampa el server AL PUBLICAR, así que una re-emisión
  // completa suele llegar sin uno solo: tomar eso por "documento distinto" partía el
  // artefacto en dos en cada edición grande y dejaba el enlace apuntando al primero.
  if (cur.size === 0 || next.size === 0) return true;
  for (const id of next) if (cur.has(id)) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// eb-patch — EDICIÓN QUIRÚRGICA del artefacto HTML. En vez de re-emitir el documento
// entero para cambiar una tarjeta (40 KB de ida y 40 KB de vuelta, más la deriva de que
// el modelo "mejore" lo que nadie pidió), el agente manda SOLO el subárbol del nodo:
//
//   ```eb-patch a17
//   <div data-id="a17" class="…">…</div>
//   ```
//
// El id va en la CABECERA, no solo dentro del fragmento: mientras el fence está abierto
// todavía no llegó el atributo, y el panel necesita saber YA a qué nodo apunta para
// resaltarlo. Si el fragmento trae otro `data-id`, gana la cabecera (mismo criterio que
// `htmlToNode(html, keepId)` del canvas-editor).
// Las TRES operaciones mínimas sobre un árbol — nada específico de un artefacto concreto:
//   ```eb-patch  a17```           reemplaza el nodo a17 por el subárbol que trae el bloque
//   ```eb-remove a17```           lo quita (sin re-emitir a sus hermanos)
//   ```eb-insert a12 append```    inserta el subárbol; `pos` = append|prepend|before|after
//                                 (append/prepend cuelgan DENTRO de a12; before/after lo
//                                  ponen junto a a12, como hermano)
export type EbPatchOp = "replace" | "remove" | "insert";
export type EbInsertPos = "append" | "prepend" | "before" | "after";

export type EbPatch = {
  nodeId: string; // dirección: el nodo objetivo (o el ancla, en insert)
  html: string; // subárbol completo (outerHTML); "" en remove
  closed: boolean; // ¿llegó el ``` de cierre? (mientras no, sigue streameando)
  op?: EbPatchOp; // por defecto "replace"
  pos?: EbInsertPos; // solo en insert
  remove?: boolean; // atajo de compatibilidad para op === "remove"
};

const PATCH_OPEN = /(^|\n)```eb-(patch|insert)[ \t]+([^\n`]+)\n/g;
// Borrado explícito. Sin esto, quitar una tarjeta obligaba a re-emitir el nodo PADRE
// completo (un bloque vacío no se distingue de uno a medio escribir) — y el preview
// repintaba toda la rejilla, que es justo lo que la edición quirúrgica quiere evitar.
const REMOVE_LINE = /(^|\n)```eb-remove[ \t]+([^\n`]+)\n?```/g;

/**
 * Extrae TODOS los bloques ```eb-patch``` del body acumulado. Igual que `extractEbDoc`:
 * idempotente (se re-escanea el body entero en cada chunk; el llamador compara con lo ya
 * aplicado), tolerante al fence abierto, y el fence SOLO cuenta si abre línea — mencionarlo
 * en prosa no debe disparar nada (regresión sufrida el 2026-07-25 con eb-artifact).
 * Un patch sin id o con cuerpo vacío no existe: se descarta aquí y nunca llega a aplicarse.
 */
export function extractEbPatches(body: string): EbPatch[] {
  const out: EbPatch[] = [];
  REMOVE_LINE.lastIndex = 0;
  let r: RegExpExecArray | null;
  while ((r = REMOVE_LINE.exec(body))) {
    const nodeId = r[2].trim();
    if (nodeId) out.push({ nodeId, html: "", closed: true, op: "remove", remove: true });
  }
  PATCH_OPEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATCH_OPEN.exec(body))) {
    const isInsert = m[2] === "insert";
    // En insert la cabecera es `<ancla> <posición>`; en patch, solo el id.
    const [nodeId, rawPos] = m[3].trim().split(/[ \t]+/);
    const pos = (["append", "prepend", "before", "after"] as const).includes(rawPos as EbInsertPos)
      ? (rawPos as EbInsertPos)
      : "append";
    const start = m.index + m[0].length;
    const rest = body.slice(start);
    const closeIdx = rest.indexOf("\n```");
    const html = closeIdx === -1 ? rest : rest.slice(0, closeIdx);
    if (nodeId && html.trim()) {
      out.push(
        isInsert
          ? { nodeId, html, closed: closeIdx !== -1, op: "insert", pos }
          : { nodeId, html, closed: closeIdx !== -1, op: "replace" }
      );
    }
    if (closeIdx === -1) break; // fence abierto → no hay nada más que parsear
    PATCH_OPEN.lastIndex = start + closeIdx;
  }
  return out;
}

/**
 * Cabecera de patch HUÉRFANA: quedó el `eb-patch <id>` pero se perdió el ``` que lo
 * abría, así que `stripEbPatches` ya no lo reconoce y su contenido se va tal cual al
 * chat. Visto en producción (msg 1093, 2026-07-29): la burbuja mostró
 * "eb-patch n3 **FELIPE CERON MARTINEZ**, personalidad que acredito…".
 *
 * No se sabe todavía QUÉ come el fence de apertura —los casos reproducidos en test
 * pasan limpios—, así que esto es contención, no arreglo: lo que no puede pasar es que
 * el usuario vea las tripas del protocolo en su conversación. Cuando aparezca la causa,
 * este barrido debería dejar de encontrar nada (por eso avisa al log).
 */
const HUERFANO = /(^|\n)(eb-(?:patch|insert|remove))[ \t]+([^\n`]+)\n([\s\S]*?)(\n```|$)/g;

/** Se avisa UNA vez por sesión: durante el streaming esto se llama por cada tick y el
 *  aviso repetido tapaba en la consola justo los logs que hacen falta para depurar. */
let avisadoHuerfano = false;

export function stripOrphanPatch(body: string): string {
  if (!/(^|\n)eb-(patch|insert|remove)[ \t]/.test(body)) return body;
  const out = body.replace(HUERFANO, "$1");
  if (out !== body && !avisadoHuerfano) {
    avisadoHuerfano = true;
    // El cuerpo EXACTO que lo dispara. Se derivó siete veces a mano sin acertar: el
    // aviso se dispara en el CLIENTE, durante el streaming, y ahí el cuerpo llega a
    // trozos — los casos de test eran todos cuerpos completos.
    const i = body.search(/(^|\n)eb-(patch|insert|remove)[ \t]/);
    console.warn(
      "[ebdoc] cabecera huérfana. contexto:",
      JSON.stringify(body.slice(Math.max(0, i - 120), i + 60)),
      "| inicio del body:",
      JSON.stringify(body.slice(0, 60)),
    );
  }
  return out;
}

/** Quita los bloques de patch del texto (para el bubble del chat). */
export function stripEbPatches(body: string): string {
  return body
    .replace(/(^|\n)```eb-(patch|insert)[ \t]+[^\n`]+\n[\s\S]*?(\n```|$)/g, "$1")
    .replace(/(^|\n)```eb-remove[ \t]+[^\n`]+\n?```/g, "$1")
    .trim();
}

// Título del artefacto. Prioriza el título del fence; si no, el primer heading markdown (doc)
// o la primera celda/columna (sheet); fallback genérico por tipo.
export function draftTitle(md: string, kind: EbDocKind = "doc", fenceTitle?: string): string {
  if (fenceTitle) return fenceTitle.slice(0, 80);
  if (kind === "artifact") {
    const t = md.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] ?? md.match(/<h[1-6][^>]*>([^<]+)<\/h[1-6]>/i)?.[1];
    return (t?.trim().slice(0, 80)) || "Artefacto";
  }
  if (kind === "sheet") {
    const first = md.trim().split("\n").find((l) => l.trim());
    const cell = first?.split(",")[0]?.replace(/^"|"$/g, "").trim();
    return (cell && cell.slice(0, 80)) || "Hoja de cálculo";
  }
  // Sin fence titulado, el título sale del markdown. Se prefiere el primer `##` porque es
  // la convención que el guardrail ya le EXIGE al agente ("el título del documento va en
  // `##`, las secciones en `###`"), así que es el encabezado que de verdad nombra el
  // documento.
  //
  // ⚠️ Antes se tomaba el primer encabezado de CUALQUIER nivel, y por eso una querella
  // acababa titulada «I. OBJETO DEL DICTAMEN»: en un escrito jurídico el primer encabezado
  // es su primera sección, no su nombre. Se conserva ese comportamiento como último
  // recurso, para un markdown que no siga la convención.
  const h2 = md.match(/^##\s+(.+)$/m);
  if (h2) return h2[1].trim().slice(0, 80);
  // ⚠️ El último recurso NO puede ser "el primer encabezado que aparezca". Medido el
  // 2026-08-03: 2 de 3 motores entregan el escrito entero en `###`, así que ese fallback
  // devolvía sistemáticamente la primera SECCIÓN — salieron «I. OBJETO DEL DICTAMEN» e
  // «ÍNDICE» como nombre del documento. Se descartan los encabezados que son claramente
  // numeración o rótulo de sección y se sigue buscando uno que parezca un nombre.
  const encabezados = [...md.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => m[1].trim());
  const bueno = encabezados.find((x) => !esRotuloDeSeccion(x));
  if (bueno) return bueno.slice(0, 80);
  const first = md.trim().split("\n").find((l) => l.trim());
  const clean = first?.replace(/^[#>\-*\s]+/, "").trim();
  if (clean && !esRotuloDeSeccion(clean)) return clean.slice(0, 80);
  // Un nombre genérico es mejor que uno que MIENTE: «Documento» se corrige de un vistazo;
  // «ÍNDICE» se queda ahí meses pareciendo un título de verdad.
  return "Documento";
}

/**
 * ¿Este encabezado es el rótulo de una sección en vez del nombre del documento?
 *
 * Se usa sólo en el ÚLTIMO recurso de `draftTitle`: cuando el agente no tituló el fence y el
 * markdown no trae ningún `##`. La lista sale de escritos jurídicos reales; ante la duda
 * NO se descarta (un falso positivo deja el documento como «Documento», que es peor que un
 * título raro pero específico).
 */
function esRotuloDeSeccion(s: string): boolean {
  const x = s.trim().replace(/[.:]+$/, "");
  // Numeración romana o arábiga al inicio: «I. OBJETO DEL DICTAMEN», «1. Antecedentes».
  if (/^(?:[IVXLCDM]+|\d+)\s*[.)-]/i.test(x)) return true;
  // Rótulos que nombran una parte del escrito, nunca el escrito entero.
  return /^(índice|indice|contenido|antecedentes|hechos|considerandos|resultandos|fundamentos?(\s+de\s+derecho)?|derecho|pruebas?|petitorios?|puntos?\s+petitorios?|conclusiones?|introducci[óo]n|objeto|objetivo|alcance|glosario|anexos?|firmas?|proemio|suplico|resuelve|transitorios?)$/i.test(x);
}

// ─────────────────────────────────────────────────────────────────────────────
// ask-user — artefacto INLINE de opciones clicables. El agente cierra el turno con
//   ```ask-user
//   {"question":"…","options":["A","B","C"]}
//   ```
// El surface lo detecta, quita el fence del bubble y pinta botones inline (un clic
// = enviar esa opción como respuesta). Agnóstico al modelo (texto puro): funciona
// igual para deepseek (ghosty-gc) y claude (claude-worker). Gemelo de extractEbDoc.

export type AskUser = {
  question: string; // pregunta (puede venir vacía → el bubble alrededor la cubre)
  options: string[]; // el texto de cada opción ES el body que se envía al elegirla
};

// Extrae el bloque ```ask-user``` (JSON {question, options[]}). Solo cuenta CERRADO y
// con al menos una opción válida — un fence a medio streamear no dispara la card.
export function extractAskUser(body: string): AskUser | null {
  const open = body.match(/```ask-user[^\n]*\n/);
  if (!open || open.index == null) return null;
  const start = open.index + open[0].length;
  const rest = body.slice(start);
  const closeIdx = rest.indexOf("```");
  if (closeIdx === -1) return null; // aún streameando → no pintamos card todavía
  const json = rest.slice(0, closeIdx).trim();
  try {
    const parsed = JSON.parse(json) as { question?: unknown; options?: unknown };
    const options = Array.isArray(parsed.options)
      ? parsed.options.map((o) => String(o).trim()).filter(Boolean)
      : [];
    if (!options.length) return null;
    const question = typeof parsed.question === "string" ? parsed.question.trim() : "";
    return { question, options: options.slice(0, 9) }; // cap 9 → teclas 1..9
  } catch {
    return null;
  }
}

// Texto de la burbuja SIN el bloque ask-user (narración alrededor). La pregunta se
// muestra dentro de la card, así que si no hay narración dejamos el bubble vacío.
export function stripAskUser(body: string): string {
  const open = body.match(/```ask-user[^\n]*\n/);
  if (!open || open.index == null) return body;
  const before = body.slice(0, open.index);
  const rest = body.slice(open.index + open[0].length);
  const closeIdx = rest.indexOf("```");
  const after = closeIdx === -1 ? "" : rest.slice(closeIdx + 3);
  return [before.trim(), after.trim()].filter(Boolean).join("\n\n");
}

// ── Alertas entrantes (Sentry) ────────────────────────────────────────────────
//
// ```gt-alert
// {"level":"error","title":"…","file":"HomeScreen.tsx","fn":"onPress","count":15,…,
//  "actions":[{"label":"Proponer el fix","send":"@ghosty revisa el error …"}]}
// ```
// Lo emite el webhook (`api.hooks.sentry.$token.ts`), no el modelo — así que el JSON
// llega siempre completo y de un solo golpe, sin streaming. Aun así se exige el fence
// CERRADO, por la misma razón que ask-user: es la única forma de no pintar media tarjeta
// si algún día alguien lo emite por partes.

export type AlertAction = { label: string; send: string };
/**
 * Una PREGUNTA del agente que espera respuesta.
 *
 * A diferencia del resto de las tarjetas, ésta tiene un turno DETENIDO al otro lado: el
 * agente bloqueó su ejecución esperando un sí o un no. Por eso lleva `taskId` — contestar es
 * continuar ESA tarea, no abrir otra— y por eso importa que el silencio tenga un default.
 *
 * Sirve para los dos protocolos: el `TASK_STATE_INPUT_REQUIRED` de A2A y el
 * `session/request_permission` de ACP son el mismo gesto con distinto nombre.
 */
export type AskCardData = {
  /** Identifica el turno detenido. Sin esto no hay a quién contestarle. */
  taskId: string;
  /** @handle del agente que preguntó. */
  handle: string;
  /**
   * La conversación a la que pertenece el turno.
   *
   * Viaja DENTRO de la tarjeta y no por props del componente a propósito: la forma del
   * groupId es una convención del servidor —lleva el namespace del workspace para las filas
   * nuevas— y la UI no tiene por qué conocerla. Así la tarjeta es autosuficiente.
   */
  groupId: string;
  question: string;
  /** Opciones a pintar. Si vienen vacías, se usan Sí/No. */
  options: { id: string; label: string; tone?: string }[];
};

export function extractAsk(body: string): AskCardData | null {
  const open = body.match(/```gt-ask[^\n]*\n/);
  if (!open || open.index == null) return null;
  const rest = body.slice(open.index + open[0].length);
  const closeIdx = rest.indexOf("```");
  if (closeIdx === -1) return null;
  try {
    const p = JSON.parse(rest.slice(0, closeIdx).trim()) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const taskId = str(p.taskId);
    const handle = str(p.handle);
    const groupId = str(p.groupId);
    const question = str(p.question);
    // Sin estos tres, la tarjeta sería un botón que no puede contestarle a nadie.
    if (!taskId || !handle || !groupId || !question) return null;
    const options = Array.isArray(p.options)
      ? (p.options as unknown[])
          .map((o) => {
            const x = o as Record<string, unknown>;
            return { id: str(x?.id), label: str(x?.label), tone: str(x?.tone) || undefined };
          })
          .filter((o) => o.id && o.label)
          .slice(0, 4)
      : [];
    return { taskId, handle, groupId, question, options };
  } catch {
    return null;
  }
}

/**
 * Tarjeta de PERMISO — el `session/request_permission` de ACP.
 *
 * Parecida a la pregunta pero NO es la misma cosa, y por eso tiene su propio fence en vez de
 * un campo que las distinga. Una pregunta es "¿qué prefieres?"; un permiso es "estoy detenido
 * y no actúo hasta que alguien me autorice". Cambia el gesto, cambia el dibujo, y cambia por
 * dónde viaja la respuesta: contestar una pregunta de A2A LANZA un turno nuevo con su
 * `taskId`, mientras que contestar un permiso sólo desbloquea la promesa que tiene detenido
 * al turno que ya está corriendo.
 *
 * El payload es deliberadamente MÁS CHICO que el de la pregunta: no lleva `groupId` ni
 * `handle` porque contestar es `resolverPermiso(ns, askId, …)` y el `ns` lo pone el servidor.
 * Lo que no se manda no se puede falsificar.
 */
export type PermissionCardData = {
  /** Se llama `askId` y no `taskId` porque en ACP no hay tareas: hay una promesa esperando. */
  askId: string;
  /** Lo que el agente quiere hacer. */
  title: string;
  /** Las que declaró el agente. Sin default: ver `extractPermission`. */
  options: { id: string; label: string; tone?: string }[];
};

export function extractPermission(body: string): PermissionCardData | null {
  const open = body.match(/```gt-perm[^\n]*\n/);
  if (!open || open.index == null) return null;
  const rest = body.slice(open.index + open[0].length);
  const closeIdx = rest.indexOf("```");
  // Fence a medio llegar: no se pinta. Unos botones incompletos son peores que ninguno
  // cuando lo que está en juego es autorizar al agente a actuar.
  if (closeIdx === -1) return null;
  try {
    const p = JSON.parse(rest.slice(0, closeIdx).trim()) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const askId = str(p.askId);
    const title = str(p.title);
    if (!askId || !title) return null;
    const options = Array.isArray(p.options)
      ? (p.options as unknown[])
          .map((o) => {
            const x = o as Record<string, unknown>;
            return { id: str(x?.id), label: str(x?.label), tone: str(x?.tone) || undefined };
          })
          .filter((o) => o.id && o.label)
          .slice(0, 4)
      : [];
    // ⚠️ SIN default Sí/No, al revés que la pregunta. Ahí inventar botones ayuda; aquí sería
    // ofrecer una autorización que el agente nunca ofreció, y el `optionId` que mandáramos no
    // significaría nada del otro lado.
    if (!options.length) return null;
    return { askId, title, options };
  } catch {
    return null;
  }
}

/** El cuerpo sin el bloque del permiso. */
export function stripPermission(body: string): string {
  const open = body.match(/```gt-perm[^\n]*\n/);
  if (!open || open.index == null) return body;
  const rest = body.slice(open.index + open[0].length);
  const closeIdx = rest.indexOf("```");
  if (closeIdx === -1) return body;
  return (body.slice(0, open.index) + rest.slice(closeIdx + 3)).trim();
}

/** El cuerpo sin el bloque de la pregunta, para no pintar el JSON crudo. */
export function bodyWithoutAsk(body: string): string {
  const open = body.match(/```gt-ask[^\n]*\n/);
  if (!open || open.index == null) return body;
  const rest = body.slice(open.index + open[0].length);
  const closeIdx = rest.indexOf("```");
  if (closeIdx === -1) return body;
  return (body.slice(0, open.index) + rest.slice(closeIdx + 3)).trim();
}

export type AlertCardData = {
  level: string;
  substatus: string;
  title: string;
  project: string;
  file: string;
  fn: string;
  count: number | null;
  users: number | null;
  env: string;
  shortId: string;
  url: string;
  actions: AlertAction[];
};

export function extractAlert(body: string): AlertCardData | null {
  const open = body.match(/```gt-alert[^\n]*\n/);
  if (!open || open.index == null) return null;
  const rest = body.slice(open.index + open[0].length);
  const closeIdx = rest.indexOf("```");
  if (closeIdx === -1) return null;
  try {
    const p = JSON.parse(rest.slice(0, closeIdx).trim()) as Record<string, unknown>;
    const title = typeof p.title === "string" ? p.title.trim() : "";
    if (!title) return null; // sin título no hay tarjeta que pintar
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
    const actions = Array.isArray(p.actions)
      ? (p.actions as unknown[])
          .map((a) => {
            const o = a as Record<string, unknown>;
            return { label: str(o?.label), send: str(o?.send) };
          })
          // Un botón sin `send` no haría nada al hacer clic, que es peor que no estar.
          .filter((a) => a.label && a.send)
          .slice(0, 4)
      : [];
    return {
      level: str(p.level) || "error",
      substatus: str(p.substatus),
      title,
      project: str(p.project),
      file: str(p.file),
      fn: str(p.fn),
      count: num(p.count),
      users: num(p.users),
      env: str(p.env),
      shortId: str(p.shortId),
      url: str(p.url),
      actions,
    };
  } catch {
    return null;
  }
}

/** El cuerpo sin el fence — queda la línea de texto plano, que es el respaldo legible. */
export function stripAlert(body: string): string {
  const open = body.match(/```gt-alert[^\n]*\n/);
  if (!open || open.index == null) return body;
  const before = body.slice(0, open.index);
  const rest = body.slice(open.index + open[0].length);
  const closeIdx = rest.indexOf("```");
  const after = closeIdx === -1 ? "" : rest.slice(closeIdx + 3);
  return [before.trim(), after.trim()].filter(Boolean).join("\n\n");
}

// ── Tarjeta de pull request ───────────────────────────────────────────────────
//
// ```gt-pr
// {"repo":"acme/api","number":412,"title":"…","author":"lupita","additions":31,
//  "deletions":4,"files":3,"checks":"failure","url":"https://github.com/…","verdict":"…"}
// ```
//
// A diferencia de `gt-alert`, ésta la emite el MODELO al cerrar una revisión — es su
// resumen, no un evento entrante. Por eso el JSON trae SÓLO datos verificables del PR y
// **ningún botón**: las acciones las pone la plataforma (`PrCard`), que sabe cuáles
// existen de verdad. Si el modelo pudiera declararlas, acabaría inventando un "Mergear"
// que no hay o un "Aprobar" en un PR que no puede aprobar.
//
// ⚠️ Y a diferencia de todo lo demás que emite el modelo, sus botones NO mandan texto al
// chat: llaman a la API con las credenciales de QUIEN HACE CLIC. Aprobar por la vía del
// chat costaría un turno entero del agente para una acción binaria, y dejaría que el
// modelo decida si de verdad aprueba.

export type PrCardData = {
  repo: string;
  number: number;
  title: string;
  author: string;
  additions: number | null;
  deletions: number | null;
  files: number | null;
  /** success | failure | pending | "" — tal cual lo reportó GitHub, nunca inferido. */
  checks: string;
  url: string;
  /** Una línea del modelo: su conclusión. Es lo único subjetivo de la tarjeta. */
  verdict: string;
  /**
   * Los hallazgos, anclados a una línea del diff. Es lo que convierte una reseña en un
   * code review de verdad: el comentario aparece JUNTO al código, no en un chat aparte.
   * `line` es la línea del archivo NUEVO y tiene que caer dentro del diff del PR.
   */
  comments: PrComment[];
  /** Liga del STAGING de este PR, si el agente levantó uno. Va COMPLETA (lleva la llave
   *  de la preview): recortarla la deja inservible. */
  preview: string;
};

export type PrComment = { path: string; line: number; body: string };

export function extractPr(body: string): PrCardData | null {
  const open = body.match(/```gt-pr[^\n]*\n/);
  if (!open || open.index == null) return null;
  const rest = body.slice(open.index + open[0].length);
  const closeIdx = rest.indexOf("```");
  if (closeIdx === -1) return null; // fence a medio streamear: no se pinta media tarjeta
  try {
    const p = JSON.parse(rest.slice(0, closeIdx).trim()) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    // 0 es un valor legítimo aquí (un PR que sólo borra tiene additions 0), así que
    // esto NO puede usar el `num` de las alertas, que descarta el cero.
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
    const repo = str(p.repo);
    const number = typeof p.number === "number" && p.number > 0 ? p.number : 0;
    // Sin repo y número no hay acciones posibles, y una tarjeta sin acciones es peor
    // que el texto que sustituye.
    if (!repo || !number) return null;
    return {
      repo,
      number,
      title: str(p.title),
      author: str(p.author),
      additions: num(p.additions),
      deletions: num(p.deletions),
      files: num(p.files),
      checks: str(p.checks).toLowerCase(),
      url: str(p.url) || `https://github.com/${repo}/pull/${number}`,
      verdict: str(p.verdict),
      // Sólo https: el modelo emite este campo y una tarjeta no es sitio para un
      // javascript: ni para una ruta relativa.
      preview: /^https:\/\//.test(str(p.preview)) ? str(p.preview) : "",
      // Un comentario sin los tres campos no se puede anclar, y mandarlo a GitHub tumbaría
      // el review entero con un 422. Se descarta aquí, igual que las acciones de gt-alert.
      comments: Array.isArray(p.comments)
        ? (p.comments as unknown[])
            .map((c) => {
              const o = c as Record<string, unknown>;
              return { path: str(o?.path), line: Number(o?.line), body: str(o?.body) };
            })
            .filter((c) => c.path && Number.isFinite(c.line) && c.line > 0 && c.body)
            .slice(0, 30)
        : [],
    };
  } catch {
    return null;
  }
}

/** El cuerpo sin el fence. Lo de alrededor es la reseña y se conserva entera. */
export function stripPr(body: string): string {
  const open = body.match(/```gt-pr[^\n]*\n/);
  if (!open || open.index == null) return body;
  const before = body.slice(0, open.index);
  const rest = body.slice(open.index + open[0].length);
  const closeIdx = rest.indexOf("```");
  const after = closeIdx === -1 ? "" : rest.slice(closeIdx + 3);
  return [before.trim(), after.trim()].filter(Boolean).join("\n\n");
}

// ── Escaneo de fences: TODAS las ocurrencias, no sólo la primera ───────────────
//
// Durante mucho tiempo `eb-audio` y `eb-file` se leían con un `match` sin flag `g`, o sea
// el PRIMER bloque y nada más. Un turno con dos notas de voz dejaba la segunda **cruda en
// el chat**: el fence sobrevivía en `gc_messages.body`, Markdown lo pintaba como bloque de
// código y el usuario veía la URL firmada del .ogg (incidente 2026-07-31). `eb-doc` ya
// había pasado por esto y lo resolvió con un bucle propio; esto generaliza aquel arreglo
// para que el siguiente tipo de bloque nazca correcto.
type Fence = { start: number; end: number; raw: string; closed: boolean };

/**
 * Todos los bloques ```<name>``` del cuerpo, en orden.
 *
 * Un bloque SIN cerrar (el modelo sigue escribiendo) se reporta con `closed:false` y corta
 * el escaneo: lo que venga después está dentro de él, no es un bloque hermano.
 */
function scanFences(body: string, name: string): Fence[] {
  const re = new RegExp("```" + name + "[^\\n]*(\\n|$)", "g");
  const out: Fence[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const contentStart = m.index + m[0].length;
    const closeIdx = body.indexOf("```", contentStart);
    if (closeIdx === -1) {
      out.push({ start: m.index, end: body.length, raw: body.slice(contentStart), closed: false });
      break;
    }
    out.push({ start: m.index, end: closeIdx + 3, raw: body.slice(contentStart, closeIdx), closed: true });
    re.lastIndex = closeIdx + 3; // saltar el bloque entero: su contenido no se re-escanea
  }
  return out;
}

/** Recorta del cuerpo los tramos indicados y pega lo que queda con una línea en blanco. */
function cutFences(body: string, fences: Fence[]): string {
  if (!fences.length) return body;
  const parts: string[] = [];
  let prev = 0;
  for (const f of fences) {
    parts.push(body.slice(prev, f.start));
    prev = f.end;
  }
  parts.push(body.slice(prev));
  return parts.map((p) => p.trim()).filter(Boolean).join("\n\n");
}

/** JSON de un fence cerrado, o null si no parsea / no trae `url`. */
function fenceJson<T extends { url?: unknown }>(f: Fence): T | null {
  if (!f.closed) return null;
  try {
    const obj = JSON.parse(f.raw.trim()) as T;
    if (!obj?.url || typeof obj.url !== "string") return null;
    return obj;
  } catch {
    return null;
  }
}

// ── Nota de voz ────────────────────────────────────────────────────────────────
// El SDK del box (voice.mjs) sintetiza el audio, lo publica y emite un bloque
//   ```eb-audio\n{"url","waveform","durationMs","mime"}\n```
// que el agente incluye en su respuesta. El server lo parsea → re-sube el ogg a
// nuestro storage → adjunto audio (gc_attachments) → burbuja de nota de voz.
export type EbAudio = { url: string; waveform?: string; durationMs?: number; mime?: string };

/** TODAS las notas de voz del cuerpo, en orden. Un turno puede traer varias. */
export function extractAllEbAudio(body: string): EbAudio[] {
  return scanFences(body, "eb-audio")
    .map((f) => fenceJson<EbAudio>(f))
    .filter((a): a is EbAudio => a != null);
}

/** La primera nota de voz, o null. Conveniencia sobre `extractAllEbAudio`. */
export function extractEbAudio(body: string): EbAudio | null {
  return extractAllEbAudio(body)[0] ?? null;
}

// Quita TODOS los bloques ```eb-audio``` de la burbuja (los audios van como adjuntos).
export function stripEbAudio(body: string): string {
  return cutFences(body, scanFences(body, "eb-audio").filter((f) => f.closed));
}

// ── Archivo generado (PDF, PNG, lo que sea) ───────────────────────────────────
// El SDK del box produce un archivo (render.mjs → PDF/PNG), lo publica y emite
//   ```eb-file\n{"url","name","mime","size"}\n```
// Mismo camino que eb-audio: el server lo descarga, lo re-sube a NUESTRO storage
// y lo adjunta → tarjeta de archivo con descarga.
//
// Existe porque un archivo ya generado no tenía bloque: al agente sólo le
// quedaba escribir un link en markdown, y `eb-doc` —lo único que daba tarjeta—
// exporta .docx, así que pedir "un PDF" devolvía Word.
//
// Que se vuelva adjunto no es sólo cosmético: deja de depender de que la URL
// publicada siga viva, y queda buscable y reenviable como cualquier otro archivo.
export type EbFile = { url: string; name?: string; mime?: string; size?: number; thumb?: string };

/** TODOS los archivos generados del cuerpo, en orden. Un turno puede producir varios. */
export function extractAllEbFile(body: string): EbFile[] {
  return scanFences(body, "eb-file")
    .map((f) => fenceJson<EbFile>(f))
    .filter((a): a is EbFile => a != null);
}

/** El primer archivo, o null. Conveniencia sobre `extractAllEbFile`. */
export function extractEbFile(body: string): EbFile | null {
  return extractAllEbFile(body)[0] ?? null;
}

/** Quita TODOS los bloques ```eb-file``` de la burbuja (los archivos van como adjuntos). */
export function stripEbFile(body: string): string {
  return cutFences(body, scanFences(body, "eb-file").filter((f) => f.closed));
}

// Versión para RENDER (cliente): mientras el bloque ```eb-audio``` aún streamea (sin
// cierre), en vez de mostrar el JSON crudo pinta un placeholder; ya cerrado lo quita
// (el reproductor entra como adjunto). Tolera el fence a medio abrir (```eb-au…).

/**
 * Oculta un fence de apertura INCOMPLETO al final del cuerpo.
 *
 * Mientras el modelo escribe ```` ```eb-audio ```` el texto pasa por ```` ``` ````,
 * ```` ```e ````, ```` ```eb ````… y en esos instantes Markdown ve un bloque de
 * código ABIERTO y lo pinta como tal: un recuadro vacío que aparece y desaparece.
 * Los helpers por tipo (`bubbleWithoutEbAudio`, …) sólo cubren desde que el nombre
 * es reconocible, así que ese parpadeo se colaba igual.
 *
 * Esto es genérico a propósito: vale para eb-doc, eb-artifact, eb-file y para
 * cualquier bloque que se invente después. Sólo actúa sobre el fence FINAL sin
 * cerrar — un bloque de código legítimo del agente (ya cerrado) no se toca.
 */
export function hideDanglingFence(body: string): string {
  // Fence al final SIN newline todavía: aún se está escribiendo su nombre.
  const dangling = body.match(/\n?```[a-zA-Z0-9-]*$/);
  if (!dangling || dangling.index == null) return body;
  // ¿Éste ABRE un bloque a medio escribir, o CIERRA uno ya completo? Al final del
  // texto los dos se ven igual, y lo decide la PARIDAD de fences: impar → éste abre y
  // no tiene cierre (se oculta); par → éste ES el cierre, y quitarlo deja el bloque
  // abierto para siempre.
  //
  // Sin esta comprobación, un reply que termina exactamente en el fence de cierre
  // (sin salto final — el caso normal) perdía ese cierre, así que `extractEbPatches`
  // lo leía como abierto y el bubble se quedaba en "🩹 Ajustando el artefacto…" para
  // siempre. Lo grave no es el marcador optimista: es que un patch FALLIDO nunca
  // llegaba a anunciarse, que es justo la disciplina de fallo VISIBLE.
  const fences = (body.match(/(^|\n)```/g) ?? []).length;
  if (fences % 2 === 0) return body;
  return body.slice(0, dangling.index).trimEnd();
}

export function bubbleWithoutEbAudio(body: string): string {
  const fences = scanFences(body, "eb-audio");
  if (!fences.length) {
    // ¿fence a medio escribir mientras streamea? (```eb-a … sin newline aún)
    const partial = body.match(/```eb-a[a-z-]*$/);
    if (partial && partial.index != null) {
      const before = body.slice(0, partial.index).trim();
      return [before, "🎙️ Grabando la nota de voz…"].filter(Boolean).join("\n\n");
    }
    return body;
  }
  // El último puede estar ABIERTO (aún grabando): los cerrados se quitan —su audio ya es
  // un adjunto— y el abierto se sustituye por el placeholder. Como el abierto se come todo
  // hasta el final del cuerpo, no queda ningún fence suelto que descuadre la paridad que
  // mira `hideDanglingFence`.
  const last = fences[fences.length - 1];
  const cerrados = fences.filter((f) => f.closed);
  if (last.closed) return cutFences(body, cerrados);
  const before = cutFences(body.slice(0, last.start), cerrados).trim();
  return [before, "🎙️ Grabando la nota de voz…"].filter(Boolean).join("\n\n");
}

// ── Estado de tools (checklist estilo Claude Code) ───────────────────────────────
// El server emite el estado de las herramientas del turno como un bloque cercado al
// INICIO del body:  ```gt-tools\n{"tools":[{label,status,n?}]}\n```  . El cliente lo
// parsea → burbuja ToolGroup colapsable; el resto del body es prosa. Se re-emite entero
// en cada paint (siempre cerrado) → el cliente ve un bloque completo en cada update.
export type ToolStatus = "running" | "done" | "error";
export type ToolState = { label: string; status: ToolStatus; n?: number; detail?: string };

export function extractToolState(body: string): ToolState[] | null {
  const open = body.match(/```gt-tools[^\n]*\n/);
  if (!open || open.index == null) return null;
  const rest = body.slice(open.index + open[0].length);
  const closeIdx = rest.indexOf("```");
  if (closeIdx === -1) return null; // JSON a medio streamear → espera al cierre
  try {
    const obj = JSON.parse(rest.slice(0, closeIdx).trim()) as { tools?: unknown };
    if (!Array.isArray(obj.tools)) return null;
    const tools = (obj.tools as ToolState[]).filter((t) => t && typeof t.label === "string" && !!t.status);
    return tools.length ? tools : null;
  } catch {
    return null;
  }
}

// ── Pasos de la narración ────────────────────────────────────────────────────────
// Lo que el agente va contando ENTRE tools ("saco el brandkit", "ya tengo la
// paleta") son pasos del trabajo, no la respuesta. Concatenados se leían como un
// párrafo corrido donde nada se distingue; el server los manda aparte en
// ```gt-steps\n{"steps":["…"]}\n``` y el chat los pinta con palomita.
//
// El ÚLTIMO segmento NO va acá: ése es la respuesta y se queda como prosa. Si
// entrara a la lista, la respuesta final quedaría disfrazada de paso.
export function extractSteps(body: string): string[] | null {
  const open = body.match(/```gt-steps[^\n]*\n/);
  if (!open || open.index == null) return null;
  const rest = body.slice(open.index + open[0].length);
  const closeIdx = rest.indexOf("```");
  if (closeIdx === -1) return null; // a medio streamear
  try {
    const obj = JSON.parse(rest.slice(0, closeIdx).trim()) as { steps?: unknown };
    if (!Array.isArray(obj.steps)) return null;
    const steps = (obj.steps as string[]).filter((x) => typeof x === "string" && x.trim());
    return steps.length ? steps : null;
  } catch {
    return null;
  }
}

export function stripStepsBlock(body: string): string {
  const open = body.match(/```gt-steps[^\n]*\n/);
  if (!open || open.index == null) return body;
  const before = body.slice(0, open.index);
  const rest = body.slice(open.index + open[0].length);
  const closeIdx = rest.indexOf("```");
  const after = closeIdx === -1 ? "" : rest.slice(closeIdx + 3);
  return (before + after).replace(/^\s+/, "");
}

// Quita el bloque ```gt-tools``` del body (el estado se muestra como burbuja, no como texto).
export function stripToolBlock(body: string): string {
  const open = body.match(/```gt-tools[^\n]*\n/);
  if (!open || open.index == null) return body;
  const before = body.slice(0, open.index);
  const rest = body.slice(open.index + open[0].length);
  const closeIdx = rest.indexOf("```");
  const after = closeIdx === -1 ? "" : rest.slice(closeIdx + 3);
  return (before + after).replace(/^\s+/, "");
}

// Texto de la burbuja del chat SIN el bloque (narración alrededor). Mientras streamea (no
// cerrado) deja un marcador para que el chat no muestre el markdown/csv crudo.

/**
 * Igual que `bubbleWithoutEbAudio` pero para archivos: mientras el bloque
 * ```eb-file``` streamea, en vez del JSON crudo deja un marcador; ya cerrado lo
 * quita (el archivo entra como adjunto).
 */
export function bubbleWithoutEbFile(body: string): string {
  // Mismo criterio que `bubbleWithoutEbAudio`: TODOS los cerrados fuera (ya son adjuntos),
  // y el último —si sigue abierto— sustituido por su placeholder.
  const fences = scanFences(body, "eb-file");
  if (!fences.length) return body;
  const last = fences[fences.length - 1];
  const cerrados = fences.filter((f) => f.closed);
  if (last.closed) return cutFences(body, cerrados);
  const before = cutFences(body.slice(0, last.start), cerrados).trim();
  return [before, "📎 Preparando el archivo…"].filter(Boolean).join("\n\n");
}

/**
 * ⚠️ `keepStatus` existe porque esta función hace DOS trabajos que no son el mismo.
 *
 * Nació el 2026-07-24 con la burbuja `ToolGroup`, y su cometido era de RENDER: que los
 * fences de estado no se pinten como texto crudo dentro del markdown, porque justo arriba
 * `extractToolState`/`extractSteps` ya los pintaron como burbuja.
 *
 * Pero el server la usa también para PERSISTIR (chat.ts y dm.ts, camino de
 * documento/artefacto/patch), y ahí quitar los fences es pérdida de datos: el cliente saca
 * la lista de herramientas del PROPIO body con `extractToolState` — no hay canal lateral ni
 * columna aparte—, así que un mensaje que entrega documento se guardaba SIN su cuadro y ya
 * no había de dónde recuperarlo. Uno que entrega archivo sí lo conservaba, porque su rama
 * persiste con `stripEbFile(stripEbAudio(reply))` y nunca pasa por aquí. Esa asimetría se
 * midió el 2026-08-03 comparando dos agentes del mismo turno.
 *
 * Regla: para PINTAR, sin `keepStatus`. Para GUARDAR, con `keepStatus: true`.
 */
export function bubbleWithoutEbDoc(
  body: string,
  patchOutcome?: { applied: number; failed: string[] },
  opts?: { keepStatus?: boolean },
): string {
  // Primero saca el bloque de estado de tools (se pinta como burbuja) y la nota de voz.
  if (!opts?.keepStatus) {
    body = stripToolBlock(body);
    body = stripStepsBlock(body);
    // Misma regla que arriba: al PINTAR fuera (la tarjeta ya lo muestra), al GUARDAR
    // dentro — el cliente saca la alerta del propio body y no hay columna aparte.
    body = stripAlert(body);
    // La tarjeta de PR sí convive con su prosa (la reseña ES el valor y se queda en el
    // bubble); lo que no puede quedarse es el JSON del fence, que Markdown pintaría
    // como un recuadro de código con el número del PR dentro.
    body = stripPr(body);
    // ⚠️ Y la de tarea, por lo mismo. Olvidarla dejaba el JSON crudo pintado como un
    // recuadro de código ENCIMA de la tarjeta —que ya dice lo mismo, bonito—, y de paso
    // metía la URL de la tarea en el cuerpo, así que el chat le colgaba debajo una vista
    // previa genérica del sitio. Un fence sin `strip` no es medio bug: son tres.
    body = stripTask(body);
    body = stripTests(body);
    // ⚠️ Éstas dos faltaban, y es exactamente el bug que describe el comentario de `stripTask`
    // ahí arriba. `bodyWithoutAsk` existía desde que se hizo la tarjeta de A2A pero no la
    // llamaba NADIE: el JSON de cada pregunta se pintaba como recuadro de código justo encima
    // de la tarjeta que ya dice lo mismo, bonito. La de permiso nace con su strip puesto.
    body = bodyWithoutAsk(body);
    body = stripPermission(body);
  }
  body = bubbleWithoutEbAudio(body);
  body = bubbleWithoutEbFile(body);
  // Al final de todo: si quedó un fence a medio abrir (el modelo aún escribe el
  // nombre del bloque), fuera — si no, Markdown lo pinta como recuadro vacío.
  body = hideDanglingFence(body);
  // Patches quirúrgicos: fuera del bubble (nunca HTML crudo en el chat) con su propio
  // marcador. Van antes que eb-doc porque un turno puede traer patches y nada más.
  const patches = extractEbPatches(body);
  if (patches.length) {
    const around = stripEbPatches(body);
    const done = patches.every((p) => p.closed);
    // Con el resultado REAL (lo sabe el server tras aplicar) el marcador dice la verdad:
    // nada de "✅ actualizado" seguido de "⚠️ no pude aplicar" en el mismo mensaje.
    let mark: string;
    if (!done) mark = "🩹 Ajustando el artefacto…";
    else if (!patchOutcome) mark = `✅ Artefacto actualizado — ${patches.length} ajuste${patches.length > 1 ? "s" : ""}`;
    else if (patchOutcome.applied === 0)
      mark = `⚠️ No pude aplicar el ajuste (${patchOutcome.failed.join(", ")}). Pídemelo otra vez y regenero el artefacto completo.`;
    else if (patchOutcome.failed.length)
      mark =
        `✅ Artefacto actualizado — ${patchOutcome.applied} de ${patchOutcome.applied + patchOutcome.failed.length} ajustes` +
        ` (no aplicó: ${patchOutcome.failed.join(", ")})`;
    else mark = `✅ Artefacto actualizado — ${patchOutcome.applied} ajuste${patchOutcome.applied > 1 ? "s" : ""}`;
    const limpio = stripOrphanPatch(around);
    return limpio ? `${limpio}\n\n${mark}` : mark;
  }
  // TODOS los fences, no sólo el primero. `extractEbDoc` devuelve el primero y deja el
  // resto en `after`, así que un mensaje con DOS artefactos (el agente se corrige y
  // re-emite: pasa seguido) dejaba el segundo crudo en el chat — un cuadro de código
  // gigante con el nombre del protocolo por cabecera, justo lo que nunca debe verse.
  // Desaparecía al terminar el turno, porque el body que se PERSISTE ya viene limpio: o
  // sea que se veía sólo mientras el agente escribía, que es cuando la gente está mirando.
  //
  // El marcador lo pone el ÚLTIMO fence: es el que sigue en vuelo, y dos "Generando el
  // artefacto…" en la misma burbuja se leen como dos trabajos.
  let resto = body;
  let doc: EbDoc | null = null;
  for (let d = extractEbDoc(resto); d; d = extractEbDoc(resto)) {
    doc = d;
    const siguiente = [d.before.trim(), d.after.trim()].filter(Boolean).join("\n\n");
    // Red contra un bucle infinito: si no encogió, se corta aquí.
    if (siguiente.length >= resto.length) break;
    resto = siguiente;
  }
  if (!doc) return stripOrphanPatch(body);
  const around = resto.trim();
  if (doc.closed) {
    const ready = doc.kind === "sheet" ? "📊 Hoja lista" : doc.kind === "artifact" ? "🎨 Artefacto listo" : "📄 Documento listo";
    return around || `${ready} — ábrelo en el panel.`;
  }
  const writing =
    doc.kind === "sheet" ? "📊 Generando la hoja…" : doc.kind === "artifact" ? "🎨 Generando el artefacto…" : "✍️ Redactando el documento…";
  return around ? `${around}\n\n${writing}` : writing;
}

/* ── Tarjeta de TAREA (```gt-task```) ─────────────────────────────────────── */
// Gemela de gt-pr. Misma división de trabajo: el MODELO emite datos, la PLATAFORMA pone los
// botones. Si el modelo pudiera declararlos inventaría un "Cerrar sprint" que no existe.

export type TaskCardData = {
  id: number;
  title: string;
  board: string;
  column: string;
  assignee: string;
  priority: string;
  due: string;
  url: string;
};

export function extractTask(body: string): TaskCardData | null {
  const open = body.match(/```gt-task[^\n]*\n/);
  if (!open || open.index == null) return null;
  const rest = body.slice(open.index + open[0].length);
  const closeIdx = rest.indexOf("```");
  if (closeIdx === -1) return null; // fence a medio streamear: no se pinta media tarjeta
  try {
    const p = JSON.parse(rest.slice(0, closeIdx).trim()) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const id = typeof p.id === "number" && p.id > 0 ? p.id : 0;
    const title = str(p.title);
    // Sin id no hay acciones posibles, y sin título no hay nada que enseñar: una tarjeta a
    // medias es peor que la frase que sustituye.
    if (!id || !title) return null;
    return {
      id,
      title,
      board: str(p.board),
      column: str(p.column),
      assignee: str(p.assignee),
      priority: str(p.priority).toLowerCase(),
      due: str(p.due),
      url: str(p.url),
    };
  } catch {
    return null;
  }
}

/** El cuerpo sin el fence. Lo de alrededor es la respuesta y se conserva entera. */
export function stripTask(body: string): string {
  const open = body.match(/```gt-task[^\n]*\n/);
  if (!open || open.index == null) return body;
  const before = body.slice(0, open.index);
  const rest = body.slice(open.index + open[0].length);
  const closeIdx = rest.indexOf("```");
  const after = closeIdx === -1 ? "" : rest.slice(closeIdx + 3);
  return [before.trim(), after.trim()].filter(Boolean).join("\n\n");
}

/* ── Tarjeta de RESULTADO DE TESTS (```gt-tests```) ───────────────────────── */
// Tercera del molde gt-pr / gt-task, y la más simple: SIN botones — un resultado de
// tests no se acciona, se lee. El modelo emite sólo números que corrió de verdad; la
// prosa de alrededor (su diagnóstico) se conserva entera, igual que la reseña del PR.

export type TestsCardData = {
  repo: string;
  ref: string;
  sha: string;
  /** El comando que corrió tal cual (`npm test`, `npx vitest run`…). Es el dato verificable. */
  command: string;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  /** Segundos, tal como los reportó el runner. */
  duration: number | null;
  failures: TestFailure[];
};

/** `path`/`line` anclan el fallo al código: la tarjeta lo liga a GitHub, como las
 *  anotaciones de Actions. Opcionales — un fallo sin ubicación sigue valiendo. */
export type TestFailure = { test: string; message: string; path: string; line: number | null };

export function extractTests(body: string): TestsCardData | null {
  const open = body.match(/```gt-tests[^\n]*\n/);
  if (!open || open.index == null) return null;
  const rest = body.slice(open.index + open[0].length);
  const closeIdx = rest.indexOf("```");
  if (closeIdx === -1) return null; // fence a medio streamear: no se pinta media tarjeta
  try {
    const p = JSON.parse(rest.slice(0, closeIdx).trim()) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    // 0 es legítimo (una suite donde todo falla tiene passed 0), igual que en gt-pr.
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
    const repo = str(p.repo);
    const passed = num(p.passed);
    const failed = num(p.failed);
    // Sin repo no se sabe de qué habla, y sin UN conteo no hay resultado que enseñar.
    if (!repo || (passed == null && failed == null)) return null;
    return {
      repo,
      ref: str(p.ref),
      sha: str(p.sha).slice(0, 12),
      command: str(p.command),
      passed,
      failed,
      skipped: num(p.skipped),
      duration: num(p.duration),
      failures: Array.isArray(p.failures)
        ? (p.failures as unknown[])
            .map((f) => {
              const o = f as Record<string, unknown>;
              return {
                test: str(o?.test),
                message: str(o?.message).slice(0, 500),
                path: str(o?.path),
                line: typeof o?.line === "number" && Number.isFinite(o.line) && o.line > 0 ? o.line : null,
              };
            })
            .filter((f) => f.test)
            .slice(0, 30)
        : [],
    };
  } catch {
    return null;
  }
}

/** El cuerpo sin el fence. El diagnóstico de alrededor se conserva entero. */
export function stripTests(body: string): string {
  const open = body.match(/```gt-tests[^\n]*\n/);
  if (!open || open.index == null) return body;
  const before = body.slice(0, open.index);
  const rest = body.slice(open.index + open[0].length);
  const closeIdx = rest.indexOf("```");
  const after = closeIdx === -1 ? "" : rest.slice(closeIdx + 3);
  return [before.trim(), after.trim()].filter(Boolean).join("\n\n");
}
