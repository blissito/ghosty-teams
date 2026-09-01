/**
 * Etiquetas humanas de las herramientas del agente.
 *
 * Vive AQUÍ y no en `agents.server.ts` porque lo necesitan los dos lados: el servidor para
 * armar el checklist del mensaje, y el drawer de Prospección para pintar lo que el agente
 * está haciendo en vivo. Importarlo desde el `.server.ts` metería código de servidor en el
 * bundle del navegador.
 *
 * Las dos formas verbales (`ing` / `done`) existen porque una tool corriendo y una tool
 * terminada no se leen igual: «Filtrando la lista» mientras trabaja, «Filtré la lista»
 * cuando acabó. Sin eso, un checklist de seis pasos ya hechos sonaba a que seguían en curso.
 */

export const TOOL_LABELS: Record<string, { ing: string; done: string }> = {
  create_document: { ing: "Creando el documento", done: "Creé el documento" },
  structured_doc: { ing: "Generando el documento", done: "Generé el documento" },
  set_section_html: { ing: "Editando el documento", done: "Edité el documento" },
  set_page_html: { ing: "Editando el documento", done: "Edité el documento" },
  update_document: { ing: "Editando el documento", done: "Edité el documento" },
  insert_page: { ing: "Agregando una página", done: "Agregué una página" },
  reorder_pages: { ing: "Reordenando páginas", done: "Reordené las páginas" },
  clone_document: { ing: "Clonando el documento", done: "Cloné el documento" },
  apply_brand_kit: { ing: "Aplicando la marca", done: "Apliqué la marca" },
  change_document_format: { ing: "Cambiando el formato", done: "Cambié el formato" },
  create_or_edit_image: { ing: "Editando una imagen", done: "Edité una imagen" },
  edit_image: { ing: "Editando una imagen", done: "Edité una imagen" },
  upload_file: { ing: "Subiendo el documento", done: "Subí el documento" },
  create_share_link: { ing: "Generando el link", done: "Generé un link para compartir" },
  render_url: { ing: "Capturando la página", done: "Capturé la página" },
  render_html: { ing: "Maquetando el PDF", done: "Maqueté el PDF" },
  office_to_pdf: { ing: "Convirtiendo a PDF", done: "Convertí a PDF" },
  deploy_document: { ing: "Publicando el documento", done: "Publiqué el documento" },
  create_website: { ing: "Creando el sitio", done: "Creé el sitio" },
  WebSearch: { ing: "Buscando en la web", done: "Busqué en la web" },
  research_search: { ing: "Investigando en la web", done: "Investigué en la web" },
  // GS Tools SDK (code-mode): el worker mapea el comando Bash real (`node …/image.mjs`)
  // a estos ids semánticos → burbujas nítidas estilo Claude Code aunque el trabajo corra
  // como Bash (que está oculto por diseño). Ver semanticToolName en claude-worker/provider.ts.
  gs_image_generate: { ing: "Generando la imagen", done: "Generé la imagen" },
  gs_image_edit: { ing: "Editando la imagen", done: "Edité la imagen" },
  gs_image_describe: { ing: "Analizando la imagen", done: "Analicé la imagen" },
  gs_voice_speak: { ing: "Grabando la nota de voz", done: "Grabé una nota de voz" },
  gs_web_search: { ing: "Buscando en la web", done: "Busqué en la web" },
  // La búsqueda del PROPIO motor, que se cobra aparte. Etiqueta distinta a propósito:
  // con el mismo texto que la de casa no había forma de ver cuál corrió.
  openai_web_search: { ing: "Buscando en la web (OpenAI)", done: "Busqué en la web (OpenAI)" },
  gs_stt_transcribe: { ing: "Transcribiendo el audio", done: "Transcribí el audio" },
  gs_web_scrape: { ing: "Leyendo la página", done: "Leí la página" },
  // Bajar el repo del cliente (github_checkout / git clone) NO es leer una página.
  gs_repo_checkout: { ing: "Descargando el repo", done: "Descargué el repo" },
  // Cajas de TRABAJO (sdk/sandbox.mjs). Se distinguen a propósito: levantar una máquina
  // consume capacidad del workspace y el usuario debe VERLO; correr algo dentro, no.
  gs_box_create: { ing: "Levantando una caja de trabajo", done: "Levanté una caja de trabajo" },
  gs_box_exec: { ing: "Trabajando en la caja", done: "Trabajé en la caja" },
  gs_box_expose: { ing: "Publicando la app", done: "Publiqué la app" },
  gs_box_destroy: { ing: "Soltando la caja", done: "Solté la caja" },
  gs_render: { ing: "Maquetando el PDF", done: "Maqueté el PDF" },
  gs_render_png: { ing: "Generando la imagen", done: "Generé la imagen" },
  // "Encargué" y no "Monté": el render corre en otra caja y tarda minutos — cuando esta
  // burbuja se cierra, el video todavía no existe. Prometer lo contrario haría que el
  // usuario lo buscara en el chat.
  gs_video_edit: { ing: "Montando el video", done: "Encargué el montaje del video" },
  gs_doc: { ing: "Armando el documento Word", done: "Armé el documento Word" },
  gs_doc_xlsx: { ing: "Armando la hoja de cálculo", done: "Armé la hoja de cálculo" },
  gs_doc_read: { ing: "Leyendo el documento", done: "Leí el documento" },
  gs_media: { ing: "Procesando el audio", done: "Procesé el audio" },
  gs_archive: { ing: "Descomprimiendo los archivos", done: "Descomprimí los archivos" },
  // Subagentes por la tool nativa (además del camino por SDK, gs_subagent_spawn).
  Task: { ing: "Repartiendo el trabajo", done: "Repartí el trabajo" },
  // Trabajo de code-mode: el agente escribe scripts y los corre. No es plumbing,
  // es COMO trabaja — y el `detail` dice sobre qué archivo.
  Bash: { ing: "Ejecutando un comando", done: "Ejecuté un comando" },
  Write: { ing: "Escribiendo un archivo", done: "Escribí un archivo" },
  Edit: { ing: "Editando un archivo", done: "Edité un archivo" },
  MultiEdit: { ing: "Editando archivos", done: "Edité archivos" },
  NotebookEdit: { ing: "Editando el notebook", done: "Edité el notebook" },
  Glob: { ing: "Buscando archivos", done: "Busqué archivos" },
  Grep: { ing: "Buscando en los archivos", done: "Busqué en los archivos" },
  BashOutput: { ing: "Revisando la salida", done: "Revisé la salida" },
  // MCP de WhatsApp (`mcp__wa__*`).
  send_poll: { ing: "Mandando la encuesta", done: "Mandé la encuesta" },
  send_location: { ing: "Mandando la ubicación", done: "Mandé la ubicación" },
  react_message: { ing: "Reaccionando al mensaje", done: "Reaccioné al mensaje" },
  get_invite_link: { ing: "Sacando el link de invitación", done: "Saqué el link de invitación" },
  // MCP de EasyBits.
  generate_image: { ing: "Generando la imagen", done: "Generé la imagen" },
  image_generate: { ing: "Generando la imagen", done: "Generé la imagen" },
  agent_create: { ing: "Creando el agente", done: "Creé el agente" },
  agent_record: { ing: "Grabando la sesión", done: "Grabé la sesión" },
  gs_db_query: { ing: "Consultando los datos", done: "Consulté los datos" },
  gs_db_write: { ing: "Guardando los datos", done: "Guardé los datos" },
  gs_subagent_spawn: { ing: "Repartiendo el trabajo", done: "Repartí el trabajo" },
  // Leer resultados guardados de un fan-out anterior. Etiqueta PROPIA y no "Repartí el
  // trabajo" porque el usuario lee esta fila para saber si el turno gastó: recuperar algo
  // ya pagado es lo contrario de lanzar trabajo nuevo.
  gs_subagent_results: {
    ing: "Recuperando trabajo anterior",
    done: "Recuperé trabajo anterior",
  },
  // `Skill` a secas = cualquier habilidad que el agente cargue, no necesariamente una de
  // documentos. Decía "Redacté el documento" SIEMPRE, así que un turno que sólo consultó
  // una guía anunciaba un documento que nunca existió (visto en prod 2026-07-29). La
  // redacción real ya la etiquetan artifact_create y la detección del bloque eb-doc; aquí
  // sólo cabe lo honesto. Cuando el worker manda cuál fue (gs_skill:<nombre>), se nombra.
  Skill: { ing: "Consultando una habilidad", done: "Consulté una habilidad" },
  // Recordatorios: tools NATIVAS, pero llegan como gs_connector:reminder_* porque el
  // agente las invoca por connectors.mjs.
  reminder_create: { ing: "Programando el recordatorio", done: "Programé el recordatorio" },
  reminder_list: { ing: "Revisando tus recordatorios", done: "Revisé tus recordatorios" },
  reminder_update: { ing: "Ajustando el recordatorio", done: "Ajusté el recordatorio" },
  reminder_cancel: { ing: "Cancelando el recordatorio", done: "Cancelé el recordatorio" },
  // Memoria de la conversación. Sin etiqueta propia salía como "Memory: write" (el
  // humanizado genérico de cualquier MCP), que no dice qué pasó ni suena a esta app.
  // Comentarios del documento. `doc_comments` es lectura → sin etiqueta, como el resto
  // de las lecturas.
  doc_comment_reply: { ing: "Respondiendo el comentario", done: "Respondí el comentario" },
  doc_comment_resolve: { ing: "Cerrando el comentario", done: "Cerré el comentario" },
  memory_write: { ing: "Anotando en la memoria", done: "Lo anoté en la memoria" },
  memory_forget: { ing: "Borrando de la memoria", done: "Lo borré de la memoria" },
  artifact_create: { ing: "Redactando el documento", done: "Redacté el documento" },
  artifact_update: { ing: "Actualizando el documento", done: "Actualicé el documento" },
  // Feedback de acciones significativas (visibilidad estilo Quick): lecturas de datos,
  // consultas a la base, y envíos. Se ocultan las lecturas de plumbing (Bash/Glob/Grep/get_).
  Read: { ing: "Leyendo un archivo", done: "Leí un archivo" },
  WebFetch: { ing: "Leyendo una página", done: "Leí una página" },
  research_scrape: { ing: "Leyendo una página", done: "Leí una página" },
  db_query: { ing: "Consultando la base", done: "Consulté la base" },
  db_select: { ing: "Consultando la base", done: "Consulté la base" },
  db_get: { ing: "Consultando la base", done: "Consulté la base" },
  db_list: { ing: "Consultando la base", done: "Consulté la base" },
  db_exec: { ing: "Escribiendo en la base", done: "Escribí en la base" },
  db_create: { ing: "Escribiendo en la base", done: "Escribí en la base" },
  db_import: { ing: "Importando datos", done: "Importé datos" },
  send_message: { ing: "Enviando el mensaje", done: "Envié el mensaje" },
  send_email: { ing: "Enviando el correo", done: "Envié el correo" },
  send_broadcast: { ing: "Enviando el broadcast", done: "Envié el broadcast" },
  create_form: { ing: "Creando el formulario", done: "Creé el formulario" },
  // Formularios NATIVOS (connectors/native.server.ts). `create_form` de arriba es el de
  // EasyBits y se queda sólo por los mensajes ya guardados que lo nombran.
  form_create: { ing: "Creando el formulario", done: "Creé el formulario" },
  form_update: { ing: "Actualizando el formulario", done: "Actualicé el formulario" },
  form_list: { ing: "Consultando los formularios", done: "Consulté los formularios" },
  form_submissions: { ing: "Leyendo las respuestas", done: "Leí las respuestas" },
  // Historial. VISIBLES a propósito, aunque la convención esconda las lecturas: que el
  // agente fue a revisar la conversación antes de contestar es justo la señal que faltaba.
  chat_search: { ing: "Buscando en la conversación", done: "Busqué en la conversación" },
  chat_history: { ing: "Revisando la conversación", done: "Revisé la conversación" },
  chat_message: { ing: "Leyendo un mensaje", done: "Leí un mensaje" },
  create_payment_link: { ing: "Generando el link de pago", done: "Generé el link de pago" },
  create_quotation: { ing: "Preparando la cotización", done: "Preparé la cotización" },
  fast_quotation: { ing: "Preparando la cotización", done: "Preparé la cotización" },
};

/**
 * Nombre legible de una tool que NO está en el mapa de etiquetas.
 *
 * `mcp__easybits__generate_image` → "generate image"; `WebFetch` → "web fetch";
 * `Bash` → "bash". Sin diccionario: se quita el prefijo MCP, se separa el
 * camelCase y los guiones, y se baja a minúsculas.
 *
 * (Enfoque tomado de BuilderIO/agent-native, `humanizeToolName` en
 * `packages/core/src/client/tool-display.ts`.)
 */
export function humanizeToolName(raw: string): string {
  let name = raw.trim();
  if (name.startsWith("mcp__")) {
    const parts = name.split("__").filter(Boolean);
    name = parts[parts.length - 1] ?? name;
  }
  name = name
    .replace(/^_+/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return name || "herramienta";
}

export const MARCAS_MCP: Record<string, string> = {
  wa: "WhatsApp",
  denik: "Deník",
  easybits: "EasyBits",
  render: "Render",
};

/**
 * Ruido de verdad: pasos que no son trabajo sino contabilidad del propio agente.
 *
 * La lista es CORTA a propósito. Antes escondía también Bash y Write con el
 * argumento de que eran "plumbing" — pero en code-mode el agente trabaja
 * escribiendo scripts y corriéndolos, así que eso ES el trabajo. Ocultarlo dejaba
 * la caja con un "Trabajando…" perpetuo durante casi todo el turno: el usuario
 * veía menos que antes, no más.
 *
 * La regla nueva: se muestra todo, y lo que no tiene nombre bonito sale con el
 * suyo humanizado más su detalle (el archivo, el patrón). Un nombre feo se lee;
 * un placeholder genérico no dice nada.
 */
export const TOOLS_OCULTAS = new Set([
  "TodoWrite",      // la lista de pendientes interna del agente
  "ToolSearch",     // buscar el esquema de una tool ANTES de usarla
  "ExitPlanMode",
  "pool_list_groups", "pool_set_group_key", // plumbing del pool de grupos de WhatsApp
]);

export function toolLabel(raw: string): { ing: string; done: string } | null {
  const short = raw.replace(/^mcp__[^_]+__/, "").replace(/^mcp__/, "");
  const conocida = TOOL_LABELS[raw] || TOOL_LABELS[short];
  if (conocida) return conocida;
  // Conector per-usuario: el worker manda `gs_connector:denik_list_appointments`.
  // El proveedor va al frente porque es lo que el usuario reconoce ("su" Deník),
  // y el resto de la acción se humaniza igual que cualquier otra.
  // Cualquier tool de un MCP que no tenga etiqueta propia: "Proveedor: acción".
  // Es la red que hace innecesario enumerar — un servidor MCP nuevo (o una tool
  // nueva de uno existente) se ve decente sin tocar este archivo.
  const mcp = raw.match(/^mcp__([a-z0-9-]+)__(.+)$/i);
  if (mcp) {
    const marca = MARCAS_MCP[mcp[1].toLowerCase()] ?? mcp[1].charAt(0).toUpperCase() + mcp[1].slice(1);
    const acc = humanizeToolName(mcp[2]);
    return { ing: `${marca}: ${acc}`, done: `${marca}: ${acc}` };
  }
  // `gs_skill:oficio` → "Habilidad: oficio". Igual que la red de los MCP: una habilidad
  // nueva se ve decente sin tocar este archivo.
  if (raw.startsWith("gs_skill:")) {
    const acc = humanizeToolName(raw.slice("gs_skill:".length));
    return { ing: `Habilidad: ${acc}`, done: `Habilidad: ${acc}` };
  }
  if (raw.startsWith("gs_connector:")) {
    const full = raw.slice("gs_connector:".length);
    // Una tool NATIVA no tiene proveedor que anteponer: "Reminder: create" se lee como si
    // Ghosty hablara con un servicio externo — justo la confusión que arrastrábamos.
    if (TOOL_LABELS[full]) return TOOL_LABELS[full];
    const [prov, ...resto] = full.split("_");
    const acc = humanizeToolName(resto.join("_") || full);
    const marca = prov.charAt(0).toUpperCase() + prov.slice(1);
    return { ing: `${marca}: ${acc}`, done: `${marca}: ${acc}` };
  }
  if (TOOLS_OCULTAS.has(raw) || TOOLS_OCULTAS.has(short)) return null;
  // Sin nombre no hay etiqueta. `humanizeToolName` cae a la palabra "herramienta" —útil
  // dentro de una frase, inútil como fila de un checklist: no dice qué se hizo y, peor, se
  // agrupa con cualquier otra sin nombre. Un evento así se descarta.
  if (!raw.trim()) return null;
  const humano = humanizeToolName(raw);
  return { ing: humano, done: humano };
}
