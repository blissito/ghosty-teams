// Resolución y routing de agentes (multi-agente). El "ghosty" implícito del
// wizard (config) + los gc_agents extra (fleet o webhook). Módulo puro server
// (sin createServerFn) para que lo usen tanto chat.ts como server/agents.ts sin
// ciclos de import.
import { hasIds, nodeIndex } from "./lib/artifact-ids";
import { ARTIFACT_DESIGN_GUIDE } from "./server/prompts/artifact-design";

export type ResolvedAgent = {
  handle: string;
  name: string;
  avatar: string;
  systemPrompt: string | null; // persona por-agente (se envía/antepone al backend)
  /** true → su groupId lleva el namespace del workspace (ver agentGroupId). */
  groupNs?: boolean;
  backend:
    // `kind` es el PROTOCOLO (fleet = nuestro contrato de agentes; webhook = un
    // POST a una URL cualquiera). `runtime`/`runtimeUrl` es DÓNDE corre ese
    // agente-fleet — hay más de un runtime que habla el mismo contrato, y la
    // elección es de cada agente, no del workspace. Ver agent-runtime.server.ts.
    | { kind: "fleet"; id: string; token: string; runtime?: string | null; runtimeUrl?: string | null }
    | { kind: "webhook"; url: string };
};

// ── Clave de conversación (groupId) ───────────────────────────────────────────
//
// El runtime keya la memoria por (fleetAgentId, groupId). El groupId se armaba en
// tres plantillas sueltas —canal, DM ask, DM clear— y NINGUNA llevaba el
// workspace:
//
//     ghosty-chat-<handle>-<slug>-<thread>     ghosty-chat-<handle>-dm-<id>
//
// Mientras cada workspace tuvo su propio agente eso no chocó por accidente: el
// par era único porque el fleetAgentId difería. En el momento en que dos
// workspaces comparten UN agente de Studio —justo lo que habilita "activar aquí
// un agente de gs"— dos `#general` producen el MISMO string, y los `dm-4` de
// ambos también: comparten sesión y memoria, y un /clear borra la del otro.
//
// Ahora la clave lleva el namespace del tenant… pero sólo para las filas que
// nacen con `group_ns`. Las viejas conservan el formato de siempre, porque
// cambiárselo les borraría la memoria a todas las conversaciones vivas. Un
// agente compartido nunca choca con uno viejo: sus claves ni se parecen.
//
// Vive acá y no en cada llamador para que el clear y el turno no puedan
// discrepar — si difieren, "borré la memoria" borra la de otra conversación.
export async function agentGroupId(
  agent: { handle: string; groupNs?: boolean },
  suffix: string,
): Promise<string> {
  const base = `ghosty-chat-${agent.handle}-${suffix}`;
  if (!agent.groupNs) return base;
  const { currentNamespace } = await import("./server/tenant.server");
  return `ws-${await currentNamespace()}-${base}`;
}

// Agentes habilitados de la instancia: primero el del wizard, luego gc_agents.
export async function resolvedAgents(): Promise<ResolvedAgent[]> {
  const db = await import("./db.server");
  const { getGhostyFleet, getConfig } = await import("./config.server");
  const out: ResolvedAgent[] = [];
  const rows = await db.listAgents();
  // @ghosty implícito (gc_config) SOLO si aún no se migró a fila gc_agents (dedup por
  // handle) — evita duplicarlo una vez que listManagedAgentsFn lo materializó.
  const fleet = await getGhostyFleet();
  // Dedup por fleet_id (no por handle) → robusto si el owner renombró el @handle del
  // @ghosty ya migrado. Sin fila con ese fleet_id → aún no migrado, lo añadimos.
  // (OJO: NO deduplicar por handle — el implícito del config trae el token FRESCO del
  // reconnect; una fila gc_agents @ghosty puede tener un fleet_token viejo → 401. El
  // implícito debe poder responder. La doble entrada @ghosty se resuelve reconciliando
  // el backend, no ocultando el que funciona. Incidente 2026-07-14.)
  if (fleet && !rows.some((a) => a.fleet_id === fleet.id)) {
    const name = (await getConfig("fleet_name")) || "Ghosty";
    out.push({
      handle: db.GHOSTY_HANDLE,
      name,
      avatar: "/ghosty.svg",
      systemPrompt: (await getConfig("ghosty_prompt")) || null,
      backend: { kind: "fleet", id: fleet.id, token: fleet.token },
    });
  }
  for (const a of rows) {
    if (!a.enabled) continue;
    if (a.kind === "webhook" && a.webhook_url) {
      out.push({ handle: a.handle, name: a.name, avatar: a.avatar || "", systemPrompt: a.system_prompt, backend: { kind: "webhook", url: a.webhook_url } });
      // El token sólo es credencial en EasyBits. Un agente nativo se opera por HMAC
      // y no guarda ninguna — exigirlo acá lo dejaba fuera del chat sin decir por qué.
    } else if (a.fleet_id && (a.fleet_token || a.runtime === "gs-native")) {
      out.push({
        handle: a.handle,
        name: a.name,
        avatar: a.avatar || "",
        systemPrompt: a.system_prompt,
        groupNs: !!a.group_ns,
        backend: { kind: "fleet", id: a.fleet_id, token: a.fleet_token ?? "", runtime: a.runtime, runtimeUrl: a.runtime_url },
      });
    }
  }
  return out;
}

// Refresca el fleet_token (pool) de un agente cuando caducó: renueva el OAuth con el
// refresh_token y re-lista la flota para tomar el token FRESCO del agente; lo persiste
// en config si es el @ghosty del wizard. Best-effort → null si el refresh no funciona
// (falta client creds / refresh_token expirado → hace falta un connect completo).
export async function refreshFleetToken(fleetId: string): Promise<string | null> {
  try {
    const { refreshOwnerToken } = await import("./server/easybits-files.server");
    const fresh = await refreshOwnerToken();
    if (!fresh) return null;
    const { listFleetAgents } = await import("./server/easybits-oauth.server");
    const agents = (await listFleetAgents(fresh)) as Array<{ id: string; token?: string }>;
    const a = agents.find((x) => x.id === fleetId);
    if (!a?.token) return null;
    const { getConfig, setConfig } = await import("./config.server");
    if ((await getConfig("fleet_agent_id")) === fleetId) await setConfig("fleet_token", a.token);
    return a.token;
  } catch {
    return null;
  }
}

// Warm seam: pre-calienta el turno de un agente ANTES de que el usuario envíe (se dispara
// al elegir @handle en el composer). Hoy: resuelve el agente (calienta el grafo de imports
// + la lectura de gc_agents) y abre la conexión al backend de la flota (DNS/TLS/keep-alive)
// para que el primer POST /message-stream no pague ese costo. Best-effort, nunca lanza.
// LÍMITE: el verdadero cuello (cold-start de la SESIÓN del worker) NO se puede calentar
// desde aquí — no hay endpoint ligero en la flota (solo turnos completos).
// TODO: cuando EasyBits exponga /warm|session-open, pingearlo aquí para primar la sesión.
export async function warmAgent(handle: string): Promise<void> {
  try {
    const agent = (await resolvedAgents()).find((a) => a.handle === handle);
    if (!agent || agent.backend.kind !== "fleet") return;
    // La base la da el runtime DEL AGENTE. Antes iba fija a easybits.cloud, así que
    // para un agente nativo esto calentaba la conexión al host equivocado — el
    // trabajo se hacía, pero no servía de nada.
    const { runtimeFor } = await import("./server/agent-runtime.server");
    const rt = await runtimeFor(agent.backend);
    await fetch(rt.base, { method: "HEAD" }).catch(() => {}); // calienta la conexión
  } catch {
    // best-effort: el warm nunca debe afectar el flujo del usuario
  }
}

// ── Media (A2A FilePart) — entrega de adjuntos al agente ────────────────────
// Contrato: docs/AGENT-MEDIA-CONTRACT.md §2/§3. Un FilePart por adjunto, tipado por
// MIME → cubre audio/imagen/video/docs/desconocido con una sola forma. Transporte
// híbrido: `bytes` inline si es chico (self-contained), `uri` firmada si es grande.
export type MediaPart = {
  kind: "file";
  file: { name?: string; mimeType: string; uri?: string; bytes?: string };
};

const MEDIA_INLINE_MAX_BYTES = 256 * 1024; // < 256KB → bytes inline; ≥ → uri firmada

export async function buildMediaParts(
  attachments: { fileId: string; mime: string | null; size: number | null; name: string | null }[],
  // forceUri: en la RE-entrega de adjuntos del hilo (ver chat.ts) nunca inline. Si no,
  // cada "continua" volvería a subir en bytes todo lo que pese menos de 256KB — en un
  // expediente de 7 documentos son varios megas por turno para nada.
  opts?: { forceUri?: boolean }
): Promise<MediaPart[]> {
  if (!attachments.length) return [];
  const { mintReadUrl, mintFileBytes } = await import("./server/easybits-files.server");
  const parts: MediaPart[] = [];
  for (const a of attachments) {
    const mimeType = a.mime || "application/octet-stream";
    const name = a.name || undefined;
    const small = !opts?.forceUri && a.size != null && a.size < MEDIA_INLINE_MAX_BYTES;
    if (small) {
      const bytes = await mintFileBytes(a.fileId);
      if (bytes) {
        parts.push({ kind: "file", file: { name, mimeType, bytes } });
        continue;
      }
    }
    // Grande, o falló el inline → uri firmada (TTL corto lo controla EasyBits).
    const uri = await mintReadUrl(a.fileId);
    if (uri) parts.push({ kind: "file", file: { name, mimeType, uri } });
  }
  return parts;
}

/**
 * Bloque de MEMORIA de la conversación para el turno.
 *
 * Va en el TEXTO y no en `appendSystemPrompt` por la misma razón que `artifactDocHint`: el
 * system prompt de la sesión persistente se fija al arrancar, y un valor variable ahí
 * forzaría cold-restart en cada turno.
 *
 * Se saca del `dest` firmado en el tool-token, que ya trae room/DM y el handle del agente —
 * el mismo dato con el que las tools de memoria escriben, así que leer y escribir no pueden
 * discrepar de alcance.
 *
 * Los ids van VISIBLES (`#3:`) porque son la dirección que el agente necesita para
 * `memory_forget` o para el `replaces` de `memory_write`. Sin ellos podría añadir una nota
 * que contradice a otra sin forma de retirar la vieja.
 *
 * Devuelve "" si no hay notas: un bloque vacío es ruido en cada turno y le enseña al modelo
 * a ignorar la sección.
 */
async function memoryHint(dest: import("./server/connectors/tool-token.server").ToolDest | null): Promise<string> {
  if (!dest) return "";
  try {
    const db = await import("./db.server");
    const scope = db.memoryScopeKey(dest);
    if (!scope || !dest.handle) return "";
    const notas = await db.listAgentMemory(scope, dest.handle);
    if (!notas.length) return "";
    const lista = notas.map((n) => `#${n.id}: ${n.note}`).join("\n");
    return (
      `[Memoria de esta conversación — convenciones YA ACORDADAS aquí. Respétalas sin volver ` +
      `a preguntar. Si una deja de aplicar, retírala con memory_forget usando su #id; si ` +
      `cambia, usa memory_write con \`replaces\`.\n${lista}]\n\n`
    );
  } catch {
    // La memoria es una comodidad: si la tabla aún no existe en este tenant o falla la
    // consulta, el turno sigue sin ella.
    return "";
  }
}

// ── Quote-reply (cita) ──────────────────────────────────────────────────────
// Extracto plano del mensaje citado para el SNAPSHOT (denormalizado en el mensaje).
// Quita bloques eb-doc/eb-sheet (ruido enorme) y colapsa espacios; ~220 chars.
export function quoteExcerpt(body: string): string {
  const stripped = (body || "")
    .replace(/```eb-(doc|sheet|artifact)[\s\S]*?```/g, "[documento]")
    .replace(/```[\s\S]*?```/g, "[código]")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > 220 ? stripped.slice(0, 220) + "…" : stripped;
}

// Superficie para el agente: embebe la cita EN el texto del turno (patrón WABA/Baileys
// contextInfo.quotedMessage) → el agente SIEMPRE ve a qué se está respondiendo, sin
// tener que buscar en el historial. Va en el TEXTO (no en el system prompt) porque
// cambia por turno.
export function quotedContextPrefix(author: string, excerpt: string, body: string): string {
  const who = author?.trim() || "alguien";
  const cite = (excerpt || "").trim();
  if (!cite) return body;
  return `[En respuesta a un mensaje de ${who}]\n> ${cite}\n\n[Mensaje]\n${body}`;
}

// Cita COMPLETA para el agente: a diferencia del excerpt del snapshot (220 chars + tapa
// bloques), conserva el contenido real del mensaje citado (para que "dame tips sobre ESTO"
// tenga el material). Cap generoso para no explotar el turno.
export function clampQuote(body: string, max = 2000): string {
  const s = (body || "").trim();
  return s.length > max ? s.slice(0, max) + "\n…[citado recortado]" : s;
}

// Bloque de HISTORIAL reciente para el turno del agente: resuelve referencias ("otra vez",
// "esto", "lo de antes") aunque la memoria del worker esté fría o un turno haya fallado.
// Va en el TEXTO (cambia por turno). Omite el mensaje ACTUAL (ya va aparte) y los vacíos.
/**
 * El "gap": los mensajes que el agente probablemente NO vio. Se corta en su última
 * respuesta propia, dando por hecho que todo lo anterior ya está en su sesión.
 *
 * ⚠️ Un RECORDATORIO no cuenta como respuesta suya. Lo publica la plataforma con su
 * cara y nunca pasó por un turno, así que no está en su transcript — y al contarlo como
 * corte quedaba fuera del contexto por los dos lados a la vez: ni en la sesión, ni en el
 * catch-up. Por eso, al responderle "ya la pagué", el agente no sabía de qué recordatorio
 * se hablaba y tenía que ir a buscarlo; y sin nada nuevo a lo que agarrarse, retomaba el
 * trabajo viejo que sí recordaba.
 */
export function gapDesdeUltimaRespuesta<
  T extends { agent_handle: string | null; body: string | null },
>(recientes: T[], esRecordatorio: (b: string | null) => boolean): T[] {
  let ultima = -1;
  recientes.forEach((m, i) => {
    if (m.agent_handle && (m.body ?? "").trim() && !esRecordatorio(m.body)) ultima = i;
  });
  return recientes.slice(ultima + 1);
}

export function historyContext(
  messages: { sender: string; agent_handle: string | null; body: string }[],
  currentBody: string
): string {
  const cur = (currentBody || "").trim();
  const lines: string[] = [];
  let total = 0;
  for (const m of messages) {
    const body = (m.body || "").trim();
    if (!body || body === cur) continue; // vacío o el propio turno actual
    const who = m.agent_handle ? `@${m.agent_handle}` : m.sender || "usuario";
    const snippet = body.length > 600 ? body.slice(0, 600) + "…" : body;
    const line = `${who}: ${snippet}`;
    if (total + line.length > 2000) break;
    total += line.length;
    lines.push(line);
  }
  if (!lines.length) return "";
  return (
    `[Mensajes recientes de la conversación que quizá NO viste (de más antiguo a más nuevo). ` +
    `En un canal solo te invocan al @mencionarte, así que puede que el usuario haya escrito lo que ` +
    `quiere en estos mensajes y luego te haya etiquetado aparte. Si el mensaje que te menciona NO trae ` +
    `una instrucción completa, la PETICIÓN real está aquí: tómala de estos mensajes y ACTÚA sobre ella ` +
    `(p. ej. "editalo, ponle otros colores" = edita el artefacto actual con otros colores). No los repitas literal. ` +
    `Esto es SÓLO lo inmediato: si te falta algo de más atrás, búscalo con chat_search / chat_history en vez de ` +
    `decir que no lo tienes.]\n` +
    `${lines.join("\n")}\n\n`
  );
}

// ¿Qué agente se mencionó en el body? Devuelve el handle o null (el primero que
// aparezca, entre los habilitados). Case-insensitive, @handle con borde de palabra.
export function detectMention(body: string, handles: string[]): string | null {
  return detectMentions(body, handles)[0] ?? null;
}

// TODOS los agentes mencionados, en orden de aparición (para multi-mención: cada
// uno responde). Case-insensitive, @handle con borde de palabra a ambos lados, sin
// duplicados. El boundary IZQUIERDO `(?<![\w@.])` evita que un email (foo@blue.com)
// dispare al agente cuyo handle coincide con el dominio.
export function detectMentions(body: string, handles: string[]): string[] {
  const hits: { handle: string; idx: number }[] = [];
  for (const h of handles) {
    const re = new RegExp(`(?<![\\w@.])@${h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    const m = body.match(re);
    if (m && m.index != null) hits.push({ handle: h, idx: m.index });
  }
  return hits.sort((a, b) => a.idx - b.idx).map((x) => x.handle);
}

// Artefacto vivo con identidad + versiones (Fase 1): instrucción per-turno SOLO para el
// canal Teams/web (panel de artefacto + editor colab). El agente usa la tool `artifact`
// (edit-in-place): un documento NUEVO = artifact_create; MODIFICAR el mismo = artifact_update
// con su id → nueva versión (no una tarjeta nueva). GTeams detecta la url del doc y la abre
// como editor colab editable. Docs con membrete/tablas/slides/PDF con diseño → skills normales.
const EB_DOC_STREAM_GUARDRAIL = [
  "QUÉ FORMATO USAR (canal Teams/web) — tiene prioridad sobre docs-router, DOC_ROUTING y cualquier skill. Elige por lo que te piden:",
  // ⚠️ La lista es LARGA a propósito: el modelo elige por COINCIDENCIA LITERAL, no por
  // categoría. El 2026-08-03 un agente pidió "recurso de apelación", la skill
  // `escrito-juridico` lo nombraba tal cual y esta lista no —decía "demanda"— así que la
  // skill ganó pese a que aquí dice que esto tiene prioridad sobre cualquier skill: entregó
  // un .docx en su workspace, inalcanzable. Si aparece un tipo de escrito nuevo, AGRÉGALO
  // aquí; una enumeración incompleta se lee como permiso.
  "· PROSA (nda, carta, oficio, contrato, convenio, demanda, contestación, recurso, recurso de apelación, apelación, amparo, escrito, promoción, alegatos, denuncia, querella, dictamen, memo, minuta, acuerdo, informe, reporte) → el documento completo en Markdown dentro de un bloque que abre con ```eb-doc y cierra con ```. **TITULA el fence**, igual que en eb-sheet: ```eb-doc Querella — Gasolinera del Bienestar. Ese título es el NOMBRE con el que el documento queda guardado en el room y el que ves en la tarjeta, así que ponle el nombre del documento, no su primera sección ni una frase larga. Si lo omites, la plataforma cae al primer encabezado del markdown y un escrito acaba llamándose «I. OBJETO DEL DICTAMEN».",
  "eb-doc — JERARQUÍA: esto es una HOJA, no una página web. El título del documento va en `##`, las secciones en `###`, y de ahí no bajes. **Nunca `#`**: es tamaño de portada, se come media hoja y al imprimir parte el título en dos líneas. Las cláusulas y apartados numerados NO son encabezados: van en negrita al inicio de su párrafo (`**PRIMERA.** El arrendatario…`, `**SEGUNDO.** Tener por acreditada…`), que es como se ve un escrito de verdad. Reserva las listas para enumeraciones reales (datos de prueba, anexos), no para el cuerpo.",
  "· TABLA / DATOS / HOJA DE CÁLCULO (listado, dataset, leads, inventario, presupuesto — lo que iría en xlsx/csv) → toda la tabla como CSV dentro de un bloque ```eb-sheet. Primera fila = encabezados, una fila por registro, comas como separador y comillas dobles si un valor lleva comas. Puedes titularlo tras la apertura: ```eb-sheet Leads Barranquilla.",
  "· APP / HERRAMIENTA / CALCULADORA / VISUALIZACIÓN / JUEGO / DEMO / LANDING con estilo o JS → un solo archivo HTML completo y autocontenido dentro de un bloque ```eb-artifact.",
  "· IMAGEN / FOTO / ILUSTRACIÓN / LOGO → un PNG real, nunca un SVG dibujado a mano ni un eb-artifact.",
  "Para estos formatos no invoques docs-router, el skill oficio, structured_doc, upload_file, mcp__wa__ ni tools de documento (get_page_html, replace_html, set_page_html, add_page…), y no generes .docx/.xlsx tú. La única excepción son los PDF con diseño, descritos al final.",
  "**El bloque se escribe SIEMPRE en tu respuesta, nunca por tool.** La plataforma renderiza en vivo lo que va apareciendo dentro del bloque: si el contenido no pasa por tu texto, el usuario se queda mirando una pantalla vacía. No lo generes con una tool del SDK, no lo escribas a un archivo, no lo publiques por tu cuenta y no lo anuncies con «Generando el artefacto…». Abre el bloque de inmediato y deja que fluya.",
  // ⚠️ Es un limite REAL del parser, no una preferencia: `extractEbDoc` (src/lib/ebdoc.ts)
  // hace `body.match(...)` y devuelve UN solo bloque. El segundo y siguientes se descartan,
  // y como `bubbleWithoutEbDoc` solo recorta el primero, los demas quedan como texto crudo
  // en la burbuja. `extractAllEbFile` y `extractAllEbAudio` si son plurales — de ahi que la
  // ruta para VARIOS sea eb-file. Esto no estaba dicho en ningun lado, asi que el agente no
  // tenia forma de saberlo: el 2026-08-03 anuncio 4 dictamenes y entrego 1.
  "UN SOLO documento por mensaje: la plataforma lee el PRIMER bloque ```eb-doc / ```eb-sheet / ```eb-artifact y DESCARTA los demás. Si te piden VARIOS documentos, la salida NO es degradarlos a archivos: **entrega UNO POR TURNO, cada uno como su ```eb-doc**, y cierra ofreciendo seguir («va el primero de cuatro; dime y sigo con el segundo»). Así cada documento conserva lo que lo hace útil — se renderiza en vivo, es editable, tiene versiones y se exporta a .docx y PDF desde el panel. Sólo cuando pidan explícitamente LOS ARCHIVOS, o quieran los N de una vez aceptando perder todo eso, van como bloques ```eb-file (uno por documento, publicados con `publishFile` de /opt/gs-sdk/storage.mjs): ésos sí se leen todos, pero son archivos muertos, no documentos vivos.",
  // ⚠️ El guardrail decia "PROSA -> eb-doc" pero nunca contemplaba "el insumo era un
  // archivo", y el modelo infiere simetria: le das un .docx, te devuelve un .docx. Medido
  // el 2026-08-03 en el caso D (2 de 3 motores). Importa porque ese caso son 4 turnos sobre
  // el MISMO reglamento: con eb-doc son versiones con historial; con .docx es un archivo
  // nuevo de 2.1 MB cada vez y el turno que compara no tiene contra que comparar.
  "QUE TE DEN UN ARCHIVO NO SIGNIFICA QUE DEBAS DEVOLVER UNO. Si el insumo fue un .docx, .pdf o .txt y el resultado es PROSA (un reglamento corregido, un contrato revisado, un escrito reescrito), entregalo como ```eb-doc igual que si te lo hubieran pedido de cero. El formato de entrada NO dicta el de salida. Devolver el archivo pierde justo lo que hace util a un documento vivo: se edita, tiene versiones, se compara con la anterior y se exporta a .docx y PDF desde el panel cuando alguien lo necesite. Manda el archivo SOLO si te lo piden explicitamente («devuelvemelo en Word», «necesito el .docx»).",
  // ⚠️ Falla reincidente y CARA de diagnosticar: si un turno anterior se corta (deploy,
  // reinicio, red), el agente lo recuerda como entregado aunque el bloque nunca se publicara.
  // En el turno siguiente contesta "ya te lo entregué, míralo en el panel" y manda a la
  // persona a buscar algo que no existe. Visto dos veces el 2026-08-03 con el mismo escrito.
  "ENTREGAR ES EMITIR EL BLOQUE EN **ESTE** MENSAJE. Tu recuerdo de haberlo escrito antes no cuenta: un turno se pudo cortar sin publicar nada. Si vas a decir que entregas algo —o que «ya está entregado», o que «lo ves en el panel»— el bloque ```eb-doc completo va EN ESTE MISMO MENSAJE. Nunca remitas a un mensaje anterior, nunca digas «revisa el panel» en lugar de emitirlo, y si te piden verlo otra vez, vuelve a escribirlo ÍNTEGRO aunque estés seguro de que ya lo mandaste. Repetirlo cuesta un turno; no repetirlo deja a la persona sin el documento y buscando un fantasma.",
  "CUENTA LO QUE ENTREGASTE ANTES DE RESUMIR. No anuncies N documentos si emitiste menos de N bloques, y no pintes una tabla de N filas cuando mandaste uno. Si sólo te dio para uno, entrega ese uno y dilo tal cual («va el primero; dime y sigo con los otros tres»). Prometer cuatro y entregar uno es peor que entregar uno: la persona se queda creyendo que los tiene.",
  "eb-artifact — estilo: incluye `<script src=\"https://cdn.tailwindcss.com\"></script>` en el <head> y estiliza con clases de Tailwind (bg-*, text-*, flex, grid, gap-*, p-*, rounded-*). El editor visual del panel edita clases, así que el layout no va en `style=\"…\"` inline ni en un `<style>` gigante; reserva `<style>` para lo que Tailwind no cubre (keyframes). Tu lógica va en un `<script>` inline; para React, Babel-standalone por CDN. Pon `<title>`.",
  "eb-artifact — tema: **define la paleta en un solo `:root{}`** con estos tokens: `--color-background`, `--color-foreground`, `--color-primary`, `--color-primary-foreground`, `--color-secondary`, `--color-secondary-foreground`, `--color-muted`, `--color-muted-foreground`, `--color-accent`, `--color-accent-foreground`, `--color-border`, más `--radius`, `--font-heading` y `--font-body`. Todo color sale de ahí vía clases arbitrarias (`bg-[var(--color-primary)]`, `text-[var(--color-foreground)]`, `border-[var(--color-border)]`). Nada de colores regados por el markup (`bg-purple-600`, `#7c3aed`, `text-white`, gradientes hardcodeados): eso rompe el recoloreado del panel y la vista pública.",
  "eb-artifact — responsivo: mobile-first y sin desbordes, legible desde 360px. Nada de anchos o altos fijos en px para contenedores; usa `w-full`, `max-w-*`, `mx-auto`, `flex-wrap`, `grid-cols-1` subiendo con `sm:`/`md:`/`lg:`, tipografía escalada (`text-3xl md:text-5xl`), padding responsivo (`px-4 md:px-8`) e imágenes `max-w-full h-auto`.",
  "IMÁGENES: cuando te pidan generar, crear o dibujar una imagen, produce un PNG real con gpt-image-2. Si tienes tool MCP de imagen (generate_image / create_or_edit_image), úsala; en code-mode usa `/opt/gs-sdk/image.mjs` (`generate` para crear, `edit` para editar una existente — no la re-dibujes). Para que se vea en el chat en code-mode: sube los bytes con `image.publish(bytes, nombre)` y emite la URL que devuelve como markdown `![descripción](url)`. Una ruta local (/tmp/…) no se muestra: el usuario vería solo texto. Sí puedes generar imágenes; no digas que no tienes herramienta.",
  "PROGRESO EN VIVO: antes de lanzar algo que tarde (generar o editar imagen, renderizar PDF, buscar o scrapear web, correr código del SDK, consultar la base) escribe una línea corta de qué vas a hacer ('🎨 Generando la imagen…', '🔎 Buscando en la web…'). Una línea, no un párrafo, y solo para lo que tarda — las lecturas rápidas no se narran.",
  "SUBAGENTES: si delegas partes de un artefacto, copia en el prompt de cada subagente las reglas de tema y responsivo de arriba. Si no, cada uno inventa su paleta y el ensamblado sale incoherente.",
  "Un bloque = un artefacto, y se muestra generándose en vivo en el panel; la plataforma lo guarda con versiones. Fuera del bloque, solo una frase breve de contexto, sin links.",
  "**No anuncies formatos que no vas a producir en ESTE turno**: la frase de contexto describe solo el bloque o bloques que realmente emites. Si solo emites eb-doc, no digas que además harás una hoja o un xlsx, ni al revés. Si piden prosa y tabla, emite ambos bloques.",
  "EXCEPCIONES — cuándo NO usar eb-doc: (a) documentos con membrete de marca fijo; (b) presentaciones (pptx); (c) cuando piden explícitamente un PDF, o un documento 'con diseño', 'vistoso', 'maquetado' o 'bonito' (eb-doc baja como .docx sin diseño). Para el PDF: arma el HTML con su CSS inline y llama a `publishPdf(html, 'nombre.pdf')` de /opt/gs-sdk/render.mjs — te devuelve el archivo publicado e imprime un bloque ```eb-file que debes incluir tal cual, para que aparezca como tarjeta descargable y no como un link suelto. Para una captura, `publishScreenshot(html, 'nombre.png')`. 'Toda prosa → eb-doc' es la regla por defecto; una petición explícita de PDF o diseño va por publishPdf. Toda tabla o dato sigue yendo a eb-sheet.",
].join(" ");

// Conocimiento del PRODUCTO Ghosty Teams: para que el agente pueda GUIAR a los usuarios
// sobre cómo se usa la app (cómo escribirle en DM, @mencionarlo, canales/hilos, llamadas,
// artefactos) en vez de quedar perdido cuando preguntan "¿cómo te escribo directo?" (le
// pasó 2026-07-23). Estable → va en appendSystemPrompt (persistencia-safe). Describe SOLO
// lo que existe de verdad; ante duda, la vía de la @mención (que siempre funciona).
const TEAMS_PRODUCT_CONTEXT = [
  "SOBRE DÓNDE VIVES — eres un agente de IA dentro de **Ghosty Teams**, una app de chat de equipo (estilo Slack) con canales, hilos, mensajes directos, llamadas y artefactos. Conoces el producto y puedes ORIENTAR a los usuarios sobre cómo usarlo.",
  "IDIOMA: escribe SIEMPRE en el idioma en el que te habla la persona, y no lo cambies a mitad de un mensaje. Eso incluye el CONTENIDO de los documentos que produces: si te piden una denuncia en español, su título y su cuerpo van en español — un escrito titulado \'CRIMINAL COMPLAINT\' no se puede presentar en un juzgado mexicano. Esto incluye las líneas de progreso y los pasos que narras entre herramientas — es donde se cuela el inglés cuando el trabajo se pone técnico, y deja la conversación en dos idiomas. Los nombres de herramientas, librerías, rutas y campos van tal cual (`python-docx`, `eb-file`, `<w:tcBorders>`), pero la frase que los rodea va en el idioma de la persona. Si te escriben en español, 'the table is a clean borderless 2×2' es un error, no un detalle.",
  "NUNCA NOMBRES EL PROTOCOLO. Los nombres de los bloques (eb-doc, eb-sheet, eb-artifact, eb-patch, eb-file, gt-tools, gt-steps) son mecánica interna de la plataforma: para la persona eso es \'el documento\', \'la hoja\', \'el artefacto\' o \'el archivo\'. Decir \'el eb-doc de este hilo\' o \'lo pongo en un bloque eb-artifact\' es como que un procesador de textos te hablara de su formato de archivo. Tampoco menciones ids internos, rutas del workspace ni nombres de tools salvo que te pregunten explícitamente cómo funciona algo.",
  "CÓMO ESCRIBES — es un chat de equipo, no un informe. Responde en 1–3 frases cuando la pregunta sea simple, y ve directo a lo que preguntaron: sin preámbulo ('Déjame verificar…', 'Perfecto, entiendo…'), sin repetir la pregunta, sin resumir al final lo que acabas de decir. Una lista sólo cuando de verdad hay varios elementos paralelos; si son dos cosas, van en una frase. No narres tu proceso interno ni aclares lo que la herramienta devolvió salvo que cambie la respuesta (la línea corta de PROGRESO EN VIVO antes de una tool lenta es la única excepción, y es una línea, no un párrafo). Extiéndete cuando el tema lo pida —un procedimiento, una comparación, algo que salió mal— pero que la longitud venga del contenido, no del relleno. Termina cuando ya respondiste: nada de '¿lo dejo así?' ni ofertas de seguimiento que nadie pidió, salvo que falte un dato para actuar.",
  "CÓMO TE ESCRIBEN: (1) **@mención** — te escriben `@" + "handle` (p.ej. @ghosty) en cualquier mensaje de un canal o respuesta de hilo, y respondes AHÍ MISMO; esto SIEMPRE funciona. (2) **Mensaje directo (DM 1:1)** — abren un chat privado contigo: haciendo clic en tu nombre/avatar para abrir tu perfil y tocando **“Mensaje directo”**, o desde el botón **“Nuevo mensaje directo” (+)** en la barra lateral eligiendo tu @handle.",
  "Si alguien dice que NO puede escribirte directo o no te encuentra: dile con calma que puede @mencionarte en CUALQUIER canal (funciona siempre) y que para un DM abra tu perfil (clic en tu nombre) → “Mensaje directo”. No lo mandes a menús que no conoces; ofrece la vía de la @mención como la segura.",
  "ESTRUCTURA: los **canales** (públicos o privados) agrupan conversaciones; los **hilos** ramifican de un mensaje para no ensuciar el canal; se puede **citar** (responder a) un mensaje puntual. Las **llamadas** (audio/video/pantalla) las inician las PERSONAS con el botón de llamada de un canal o DM y avisan a los demás con una tarjeta y notificación entrante. IMPORTANTE: TÚ (agente) todavía NO puedes iniciar ni unirte a llamadas — por ahora son entre personas (pronto podrás). Si te piden que llames o entres a una llamada, acláralo con calma y ofrece ayudar por chat.",
  "ARTEFACTOS: puedes producir documentos vivos (prosa con eb-doc), hojas de cálculo (eb-sheet) y apps HTML interactivas (eb-artifact) que se renderizan en un panel lateral y se pueden descargar/compartir; e imágenes reales con tu tool de imagen. Cuando te pidan algo así, prodúcelo — no digas que no puedes.",
  "IMÁGENES DENTRO DE UN DOCUMENTO: un documento de prosa acepta imágenes con la sintaxis normal de markdown, `![descripción](url)`, y salen tanto en el panel como en el .docx y el PDF que se exportan de ahí. Para conseguir la url, publica primero el archivo con el SDK del box (`storage.publish` para una imagen que ya tengas en disco —una foto que te adjuntaron, un plano que sacaste de un .docx—, `image.publish` para una que generes). Esto importa donde la imagen ES parte del entregable y no un adorno: un dictamen pericial sin las fotos del inmueble ni el croquis no es un dictamen, es media entrega. Si el documento las necesita, van dentro.",
  "ARTEFACTO COMPARTIDO POR LINK — cada artefacto se edita DESDE LA CONVERSACIÓN DONDE NACIÓ. En cada turno la plataforma te inyecta el contenido del artefacto ACTUAL de este hilo (si lo hay); ese es el único que puedes modificar. Si alguien te PEGA UN LINK a un artefacto (una URL de artefacto/`/t3/…`) y te pide cambiarlo, ese documento NO está cargado aquí: el link es una copia publicada, no te da acceso a editarlo. NUNCA respondas «no puedo editarlo» a secas ni lo presentes como un error o una falla tuya — EXPLICA con calma el porqué (los artefactos se editan en su propia conversación) y ofrece SIEMPRE las dos salidas: (a) que te lo pidan en el hilo/DM donde se creó, donde sí lo tienes a la mano; o (b) que te peguen aquí el contenido y creas una versión NUEVA en esta conversación.",
  "VOZ / NOTA DE VOZ: sí puedes responder con una nota de voz. En code-mode usa `/opt/gs-sdk/voice.mjs` (`speak(texto)`): sintetiza el audio, lo publica e imprime un bloque ```eb-audio que **debes incluir tal cual** en tu respuesta para que aparezca la burbuja reproducible; puedes acompañarlo de una frase corta. Voz por default masculina: `em_santa`; si piden otra, `speak(texto, { voice: \"ef_dora\" })` — em_santa (M), ef_dora (F), em_alex (M). Nunca digas que solo te comunicas por texto. (Distinto de las LLAMADAS en vivo, que aún no puedes iniciar.)",
  "CUÁNDO USAR LA VOZ por tu cuenta, sin que te la pidan: saludos, confirmaciones y respuestas cortas con personalidad — le da calidez y presencia. No en cada turno, y nunca para código, tablas, documentos ni respuestas técnicas o largas, donde el texto se lee mejor. Si la respuesta es corta pero es un DATO que van a querer releer (una hora, una cifra, un nombre, un link), va en texto.",
  "MEMORIA DE LA CONVERSACIÓN: tienes memoria propia de este room (o DM) y es REAL. Al inicio de cada turno recibes un bloque `[Memoria de esta conversación]` con las convenciones ya acordadas y su `#id`; respétalas sin volver a preguntar. Para guardar una: en code-mode, `const { run } = await import('/opt/gs-sdk/connectors.mjs')` y `await run('memory_write', { note: 'los títulos van en ##, los subtítulos en ###' })`. Para retirarla, `run('memory_forget', { id })`; si cambia, `run('memory_write', { note: '…', replaces: <id> })` en vez de añadir otra — dos notas que se contradicen es peor que ninguna. NO existe `memory_read`: ya las tienes en el turno, no las pidas. QUÉ GUARDAR: lo que alguien te dice con 'de ahora en adelante', 'siempre', 'recuérdalo' o 'anótalo' — formato de los documentos, cómo se llaman las partes, cómo firma el despacho, tratamientos, criterios de redacción. QUÉ NO: el contenido de los documentos (para eso están los artefactos y sus versiones), datos personales o sensibles que nadie te pidió guardar, ni el estado de una tarea en curso. Es del ROOM y COMPARTIDA: aplica también cuando escriba otra persona del equipo, y sigue viva en otros hilos del mismo room y después de un /clear (borra la conversación, no las convenciones). Si guardas algo, dilo en una frase — que quede claro qué vas a recordar.",
  "RECORDATORIOS: SÍ puedes programar recordatorios — es una capacidad REAL de Ghosty Teams, no depende de ningún servicio externo ni de que el usuario conecte nada. CÓMO: en code-mode, `const { run } = await import('/opt/gs-sdk/connectors.mjs')` y luego `await run('reminder_create', { text: 'pagar la tarjeta', when: '2026-08-01T09:00', repeat: 'daily'|'weekly'|'monthly' /* omítelo si es una sola vez */ })`. `when` va en hora LOCAL del usuario (YYYY-MM-DDTHH:mm): resuelve 'mañana', 'el 1 de agosto' o 'en 2 horas' con el `[Ahora: …]` que recibes al inicio del turno. Si te dictan direcciones a las que mandar copia del correo, pásalas en `emailCc: ['a@b.com']` (máx 5). También tienes `run('reminder_list')`, `run('reminder_update', { id, ...sólo lo que cambia })` — para cambiarle la hora, el texto o encenderle el correo a uno YA agendado, sin cancelarlo — y `run('reminder_cancel', { id })`. NO hace falta llamar a `list()` antes: estas tres existen SIEMPRE. A la hora pedida el recordatorio lo publicas TÚ en esta misma conversación. Al programarlo, CONFIRMA el día y la hora que devolvió la tool. CORREO: por default el aviso llega SOLO al chat; si además lo quiere por correo, pásale `email: true` — pregúntaselo en la misma frase en que confirmas ('¿te lo mando también por correo?') y no lo des por hecho.",
  "FORMULARIOS DE INTAKE: cuando te pidan un formulario, un cuestionario, un formato de alta o \"recabar datos\" de alguien que NO tiene cuenta aquí (un cliente, un tercero), usa la tool: `const { run } = await import('/opt/gs-sdk/connectors.mjs')` y `await run('form_create', { title: 'Alta de cliente', fields: [{ name: 'razon_social', type: 'text', label: 'Razón social', required: true, section: 'Datos' }, …] })`. Devuelve `{ url }`: PÁSALE esa liga al usuario tal cual — es lo que se le manda al cliente. Las respuestas caen SOLAS en esta conversación, en UNA hoja que crece con cada envío (se descarga en Excel). Para el documento de UNA respuesta —'pásame el expediente de Fulano'— usa `run('form_ficha', { formId, submissionId })`, donde `submissionId` es el `id` que te dio form_submissions. Campos: `type` es text|email|tel|textarea|select|date|number|checkbox|radio|file|matrix; agrupa con `section` (los consecutivos con la misma sección forman un paso); usa `showIf: { field, equals }` para una pregunta que sólo aplica según una respuesta ANTERIOR; en `matrix` las columnas van en `options` y las filas en `rows`. Cuando la CANTIDAD la decide quien responde (herederos, dependientes, inmuebles, hijos, socios), usa `type:'group'` con sus subcampos en `fields` y `itemLabel` ('Heredero') — NUNCA inventes heredero_1, heredero_2, heredero_3: quien tiene cinco se queda sin dónde ponerlos. Manda `locale: 'en'` cuando quien vaya a responder lee en inglés (normalmente el idioma de esta conversación): eso traduce los botones, los avisos y los errores del formulario, no sólo lo que tú escribes. Para repetir algo que ya funcionó —el mismo intake con otro cliente, o adaptar una plantilla— usa `form_create` con `fromFormId`: hereda los campos y lo que mandes los pisa, así no vuelves a dictar 40 campos. También tienes `run('form_list')` y `run('form_submissions', { formId })` para leer lo que llegó, y `run('form_update', { formId, fields })` para cambiarlo — la liga NO cambia, así que edítalo en vez de crear otro.",
  "HISTORIAL DE LA CONVERSACIÓN: tu contexto sólo trae los mensajes RECIENTES; lo de más atrás no lo tienes cargado, pero SÍ puedes ir a buscarlo. Antes de decir «no lo veo», «no lo recuerdo» o «eso no existe», búscalo: `const { run } = await import('/opt/gs-sdk/connectors.mjs')` y `await run('chat_search', { query: 'arquetipo de artífice' })` — busca por palabras en TODO lo que se dijo en esta conversación, incluidos tus propios mensajes. Para leer hacia atrás en orden, `await run('chat_history', { limit: 25 })` y, para seguir subiendo, otra llamada con `before: <oldestId de la respuesta anterior>`. Sólo alcanzan ESTA conversación (este canal, hilo o DM), que es justo la que te están preguntando. Y nunca afirmes que tienes «todo el historial en tu contexto»: no lo tienes, lo consultas.",
  "⚠️ NUNCA armes un formulario como artefacto HTML (eb-artifact). Un artefacto corre en el navegador de quien lo abre y NO puede recibir respuestas: lo que se llena ahí no le llega a nadie y no queda registrado en ninguna parte. Es una maqueta, no un formulario. Si ya hiciste uno así, dilo y créalo con `form_create`. El diseño, la validación, los pasos y el guardado los pone la plataforma — tú sólo dictas los campos, y no escribes HTML de formulario nunca.",
  "NUNCA atribuyas una falla tuya a un servicio externo que no forma parte de este producto. No existe ninguna conexión con claude.ai, ni con cuentas, paneles o comandos de otros productos: no los menciones ni los inventes como causa ni como solución. Si algo no te sale, di en una frase qué pasó y ofrece lo que sí puedes hacer.",
  "No inventes funciones ni pantallas que no existen. Si no estás seguro de un detalle de la interfaz, describe la vía de la @mención (universal) y ofrece ayudar con lo que intentaban lograr.",
].join(" ");

// Identidad VISUAL propia del agente + imagen de referencia SIEMPRE a la mano para que las
// imágenes que genere de sí mismo salgan on-model. Hoy solo para la marca por defecto
// (Ghosty); su PNG está horneado en el runtime en /opt/gs-sdk/assets/ghosty.png (COPY sdk).
// gpt-image-2 (image.edit) acepta ese path local → cero red, siempre disponible. Otras marcas
// aún no tienen referencia horneada → "" (no le inventamos una cara).
function selfIdentity(agent: ResolvedAgent | undefined): string {
  const isGhosty = !!agent && (agent.handle === "ghosty" || /ghosty/i.test(agent.avatar || ""));
  if (!isGhosty) return "";
  return [
    "TU IMAGEN (identidad visual): eres 'Ghosty', un fantasmita amistoso de estilo vectorial PLANO y minimalista: cuerpo color morado/lavanda (periwinkle), parte de arriba redondeada y borde de abajo ondulado (silueta de fantasma), grandes LENTES REDONDOS de armazón fino claro, ojos ovalados oscuros y grandes detrás de los lentes, mejillas apenas rosadas. Look limpio y tierno.",
    "IMAGEN DE REFERENCIA SIEMPRE A LA MANO: tienes un PNG tuyo de cuerpo completo (fondo transparente) horneado en tu caja en `/opt/gs-sdk/assets/ghosty.png` (canónico también en https://www.ghosty.studio/ghosty.png). Cuando te pidan generar/dibujar/editar una imagen DE TI MISMO (o una escena donde aparezcas tú), NO partas de cero: pásalo como REFERENCIA a la tool de imagen para salir on-model. En code-mode: `import { edit, publish } from '/opt/gs-sdk/image.mjs'`, luego `const png = await edit('/opt/gs-sdk/assets/ghosty.png', 'TU PROMPT describiendo la escena')` (gpt-image-2 respeta tu forma; el path local es lo más rápido, la URL pública sirve de respaldo), `const url = await publish(png, 'ghosty.png')`, y en tu respuesta emite `![...](url)` para mostrarla. Puedes pasar VARIAS referencias (array) si además te dan otra imagen.",
  ].join(" ");
}

// Si el hilo YA tiene un artefacto, al MODIFICAR el agente re-emite el artefacto COMPLETO
// (misma experiencia de streaming que al crear). Para que pueda hacerlo con fidelidad —
// aunque el worker haya reciclado su sesión — le inyectamos el contenido ACTUAL (la verdad
// local) en el TEXTO del turno. Va en el texto, NO en el system prompt: cambia por turno,
// y el system prompt de la sesión persistente se fija al arrancar (un valor variable ahí
// forzaría cold-restart). El BASE estable (EB_DOC_STREAM_GUARDRAIL) sí va en
// appendSystemPrompt (idéntico todos los turnos → persistencia-safe). Vacío si no hay artefacto.
/**
 * El artefacto VIVO del hilo, tal como lo devuelve `db.getDoc`. `documentId` viaja con él
 * porque el enlace `/artefacto/<slug>` se acuña a partir del id, no del contenido.
 */
type CurrentDoc = {
  kind: "doc" | "sheet" | "artifact";
  md: string;
  src?: string | null;
  documentId?: string;
};

async function artifactDocHint(currentDoc?: CurrentDoc | null): Promise<string> {
  // El CSS de Tailwind HORNEADO al publicar (marca `gt-baked-tw`) es derivado: se recalcula
  // solo en la siguiente publicación. Al agente no le sirve de nada y son decenas de KB de
  // contexto por turno → se lo quitamos. Si re-emite el artefacto sin él, el publish lo
  // vuelve a hornear.
  // Un DOC se persiste como sobre con el árbol de bloques, no como markdown. Al agente
  // se le devuelve MARKDOWN (es lo que escribe y lo que entiende), y aparte el índice de
  // bloques direccionables. `docMarkdown` prefiere el `sourceMd` que él mismo escribió
  // mientras nadie lo haya editado a mano: derivarlo de los bloques en cada turno serían
  // dos saltos lossy por turno, con deriva acumulada.
  let docBlocks: import("./lib/doc-blocks").DocBlock[] = [];
  let raw = currentDoc?.md ?? "";
  if (currentDoc?.kind === "doc" && raw) {
    const { parseDocEnvelope } = await import("./lib/doc-blocks");
    const env = parseDocEnvelope(raw);
    if (env) {
      docBlocks = env.blocks;
      const { docMarkdown } = await import("./server/doc-blocks.server");
      raw = await docMarkdown(currentDoc.md);
    }
  }
  const md = raw.replace(/<style gt-baked-tw>[\s\S]*?<\/style>\s*/gi, "").trim();
  if (!md) return "";
  const kind = currentDoc!.kind;
  const fence = kind === "sheet" ? "eb-sheet" : kind === "artifact" ? "eb-artifact" : "eb-doc";
  const noun =
    kind === "sheet" ? "esta hoja de cálculo (CSV)" : kind === "artifact" ? "este artefacto (HTML autocontenido)" : "este documento";
  const lang = kind === "sheet" ? "CSV" : kind === "artifact" ? "HTML" : "Markdown";
  // Enlace del artefacto para la PERSONA. Se lo damos al agente para que, si le piden
  // "el link"/"publícalo"/"compártelo", lo entregue TAL CUAL en vez de decir que no puede
  // (antes se disculpaba e inventaba que "no tengo tool para crear URLs" — incidente
  // 2026-07-23).
  //
  // Es `/artefacto/<slug>`, NO el `src` de storage: ver `shareLinkFor`. El `src` vive en
  // otro host, donde la sesión siempre es anónima, y desde que /t3 aplica el permiso
  // respondía 404 hasta al dueño — el agente estaba repartiendo un enlace roto.
  const docId = currentDoc!.documentId;
  const link =
    kind === "artifact" && docId
      ? await (await import("./server/artifacts")).shareLinkFor(docId)
      : null;
  const linkLine = link
    ? `Este artefacto ya tiene enlace propio: ${link} . ` +
      `Si el usuario pide el link / que lo publiques / que lo compartas, entrégaselo TAL CUAL (no digas que no puedes ni inventes otra URL). ` +
      `Nace PRIVADO —sólo lo abre su dueño—; para que lo vea alguien más hay que darle permiso desde el botón Compartir del panel del artefacto. ` +
      `Dilo sólo si viene al caso (te piden mandárselo a alguien), no en cada entrega. `
    : "";
  // ARTEFACTO HTML con direcciones (`data-id`) → modo QUIRÚRGICO: se le antepone el ÍNDICE
  // de nodos (el mapa para elegir el id sin releer 40 KB con atención) y se le pide un
  // ```eb-patch``` en vez del documento entero. Si el HTML es viejo (sin ids) o el modo está
  // apagado por env, cae al camino de siempre (re-emisión completa) — un turno de retraso:
  // al guardar esa re-emisión el server ya la estampa.
  // DOCUMENTO con bloques direccionables → mismo modo QUIRÚRGICO que el HTML, pero las
  // direcciones son BLOQUES, no nodos del DOM. Es la pieza que hace posible "usa las
  // cláusulas de este archivo para nuestro documento": el agente abre la fuente, extrae
  // sólo el fragmento que necesita y lo coloca en un bloque — sin re-emitir el documento
  // entero ni volcar la fuente al contexto.
  if (kind === "doc" && patchModeOn() && docBlocks.length) {
    const { blockIndex } = await import("./lib/doc-blocks");
    // 250, no 80. El tope de 80 dejaba FUERA 22 bloques de un escrito de 102, y el
    // agente lo dijo tal cual: "ese bloque no me queda direccionable, cae dentro de los
    // 22 bloques más". Un bloque que no aparece en el índice no se puede parchear, así
    // que el tope no es una optimización: es el techo de lo que se puede editar.
    // Un bloque son ~70 chars de índice (alias + tipo + 60 de texto), así que 250 son
    // ~17 KB en el peor caso — barato al lado de re-emitir el documento entero.
    const index = blockIndex(docBlocks, 250);
    return (
      `[Contexto del hilo — DOCUMENTO ACTUAL. En esta conversación ya existe ${noun}. ` +
      `Está hecho de BLOQUES y cada uno tiene su dirección (n1, n2, …). Si el usuario pide ` +
      `un cambio ACOTADO (una cláusula, un dato, un párrafo, una fila), responde con uno o ` +
      `más bloques \`\`\`eb-patch <dirección> con ESE bloque completo ya corregido, en ` +
      `Markdown — NO re-emitas el documento entero. ` +
      `Si el cambio es una reescritura de arriba abajo, entonces sí re-emite todo en un ` +
      `bloque \`\`\`eb-doc.` +
      PATCH_RULES("doc") +
      NEW_DOC_RULE(fence) +
      `\n\nSi estás tomando contenido de un documento ADJUNTO (cláusulas, datos, cifras): ` +
      `ábrelo con su herramienta, extrae SÓLO lo que necesitas y colócalo con eb-patch. ` +
      `No transcribas el documento fuente en tu respuesta.` +
      (index ? `\n\nBloques direccionables:\n${index}` : "") +
      `\n\nContenido actual en ${lang}:\n\n\`\`\`\n${md}\n\`\`\`]\n\n`
    );
  }

  const patchable = kind === "artifact" && patchModeOn() && hasIds(md);
  if (patchable) {
    // Parser del server (jsdom): sin él el índice saldría vacío en silencio, y el índice
    // es justo lo que permite al modelo elegir el data-id correcto.
    const { serverParseOpts } = await import("./server/artifact-dom.server");
    const index = nodeIndex(md, 80, await serverParseOpts());
    return (
      `[Contexto del hilo — ARTEFACTO ACTUAL. En esta conversación ya existe ${noun}. ` +
      linkLine +
      `Cada elemento lleva su dirección en \`data-id\`. Si el usuario pide un cambio ACOTADO ` +
      `(una tarjeta, un texto, un color, una fila), responde con uno o más bloques ` +
      `\`\`\`eb-patch <data-id> con el nodo completo ya corregido — NO re-emitas el artefacto entero. ` +
      `Si el cambio es un rediseño global, o toca <head>/<style>/<script>, entonces sí re-emite ` +
      `todo en un bloque \`\`\`eb-artifact.` +
      PATCH_RULES("artifact") +
      NEW_DOC_RULE(fence) +
      (index ? `\n\nNodos direccionables:\n${index}` : "") +
      `\n\nContenido actual en ${lang}:\n\n\`\`\`\n${md}\n\`\`\`]\n\n`
    );
  }
  return (
    `[Contexto del hilo — ARTEFACTO ACTUAL. En esta conversación ya existe ${noun}. ` +
    linkLine +
    `Si el usuario pide modificarlo (cambiar, ajustar, corregir, agregar/añadir algo), ` +
    `RE-EMITE el artefacto COMPLETO en un bloque \`\`\`${fence} con el cambio ya integrado y todo ` +
    `lo demás idéntico.` +
    NEW_DOC_RULE(fence) +
    ` Este es su contenido actual en ${lang}:\n\n\`\`\`\n${md}\n\`\`\`]\n\n`
  );
}

/**
 * Cómo pedir un documento NUEVO en vez de otra versión del de arriba. Sin esta regla el
 * agente no tenía forma de decirlo —re-emitir el fence significa "edita esto"— y todo lo
 * que se pidiera después se apilaba como versión del primero.
 */
/**
 * Reglas de la EDICIÓN QUIRÚRGICA. Viven aquí —en el hint por-turno, dentro del texto— y
 * NO en el system prompt: sólo tienen sentido cuando el hilo YA tiene un artefacto, que
 * es la minoría de los turnos. Moverlas costó 3.5 KB menos de system prompt en cada
 * mensaje y quitó la duplicación (se decían dos veces, con distintas palabras).
 * El system prompt NO puede variar por turno: entra por valor en el `configSig` del
 * worker y reciclaría la sesión persistente (worker.ts:452-461, :501-502).
 */
const PATCH_RULES = (kind: "doc" | "artifact") => {
  const addr = kind === "doc" ? "dirección de bloque (n1, n2, …)" : "`data-id`";
  const node = kind === "doc" ? "bloque" : "nodo";
  const lang = kind === "doc" ? "Markdown" : "HTML";
  const insert =
    kind === "doc"
      ? `\`\`\`eb-insert <dirección> before|after`
      : `\`\`\`eb-insert <data-id-del-ancla> <posición>\`, con \`append\`/\`prepend\` para colgarlo DENTRO del ancla o \`before\`/\`after\` para ponerlo junto a ella como hermano; el bloque trae el ${node} nuevo sin dirección — se la asigna la plataforma`;
  return (
    `\n\nTres operaciones, y ninguna re-emite el documento: **reemplazar** (\`\`\`eb-patch <${addr}>\`), ` +
    `**quitar** (\`\`\`eb-remove <${addr}>\` — una línea, sin contenido) y **agregar** (${insert}). ` +
    `Para añadir un elemento a una lista o rejilla, usa eb-insert sobre ella: nunca re-emitas el padre entero para agregar o quitar un hijo. ` +
    `Reglas del patch: (1) la dirección de la línea de apertura y la del ${node} raíz del bloque son la misma; ` +
    (kind === "artifact" ? `(2) el elemento raíz conserva su misma etiqueta; ` : `(2) el bloque conserva su mismo tipo; `) +
    `(3) devuelve el ${node} COMPLETO${kind === "artifact" ? " (su outerHTML, con todos sus hijos)" : ""}, no un fragmento suelto; ` +
    (kind === "artifact" ? `(4) conserva los \`data-id\` de los hijos que no cambian — son direcciones, no adorno; ` : `(4) conserva el resto del bloque tal cual; `) +
    `(5) el resultado debe ser 90%+ idéntico al original: el cambio más pequeño que cumpla lo pedido, sin 'mejorar' de paso lo que nadie pidió; ` +
    `(6) nada de ${lang} ni explicaciones fuera del bloque; ` +
    `(7) elige el ${node} más PEQUEÑO que contenga todo el cambio, y si tocas varias zonas, un bloque por zona; ` +
    `(8) un eb-insert puede traer varios hermanos y se insertan todos, pero solo ${lang}, sin prosa dentro.` +
    `\n\nEn la duda entre un patch dudoso y re-emitir completo, elige el completo: un patch que no aplica no cambia nada.`
  );
};

const NEW_DOC_RULE = (fence: string) =>
  ` Si en cambio el usuario pide algo DISTINTO (otro documento, no una modificación de éste), ` +
  `abre el bloque con la marca \`nuevo\`: \`\`\`${fence} nuevo Título del documento — así se ` +
  `crea un documento aparte en vez de una versión de éste.`;

/**
 * Kill-switch del modo quirúrgico: `ARTIFACT_PATCH=off` en el env de la caja vuelve al
 * comportamiento de siempre (re-emisión completa) sin deploy. Si el modelo resultara ser
 * malo emitiendo patches, se apaga en segundos.
 */
function patchModeOn(): boolean {
  return (process.env.ARTIFACT_PATCH ?? "on").toLowerCase() !== "off";
}

/** `[Ahora: …]` en la zona horaria del invocador (capturada del navegador). */
async function clockHint(invokerSub?: string): Promise<string> {
  try {
    const { DEFAULT_TZ, isValidTz } = await import("./server/reminders.server");
    let tz = DEFAULT_TZ;
    if (invokerSub) {
      const { dbq } = await import("./dbq.server");
      const rows = await dbq("SELECT tz FROM gc_users WHERE sub=?", [invokerSub]);
      const t = rows[0]?.tz;
      if (t && isValidTz(t)) tz = t;
    }
    // El reloj sigue el idioma de la app: si no, un documento en inglés acababa fechado
    // "lunes, 4 de agosto de 2026", que es justo la mezcla que el guardrail de idioma pide
    // evitar.
    const { currentLocale } = await import("./server/locale.server");
    const { intlLocale } = await import("./i18n.core");
    const now = new Intl.DateTimeFormat(intlLocale(await currentLocale()), {
      timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(new Date());
    return `[Ahora: ${now} (${tz})]\n`;
  } catch {
    return ""; // sin fecha es peor, pero no puede tumbar el turno
  }
}

// Streaming (first-class): llama al backend y emite la respuesta pedacito a
// pedacito por `onChunk`, devolviendo el texto final (autoritativo). Hoy solo el
// backend fleet expone SSE (EasyBits /message-stream: `chunk`/`done`/`error`); el
// webhook aún cae al camino bloqueante (Slice 4 = cliente A2A message/stream).
// Contrato: docs/AGENT-MEDIA-CONTRACT.md §1.
// Evento de tool del stream nativo. `start` inicia (name+id), `end` cierra (id+ok).
// El `id` (tool_use del SDK) correlaciona ambos → estado real ✅/❌ por tool, no posicional.
export type ToolEvent = { name?: string; id?: string; phase?: "start" | "end"; ok?: boolean; detail?: string };

/**
 * STEER: el turno no se abrió — el mensaje entró al que ya corría y su respuesta sale por
 * AQUELLA burbuja. Se propaga como valor de retorno (no como excepción) porque no es un
 * fallo: es el camino feliz de escribir mientras el agente trabaja.
 */
export const INJECTED = "\u0000injected";

export async function callAgentBackendStream(
  agent: ResolvedAgent,
  groupId: string,
  sender: string,
  text: string,
  onChunk: (chunk: string) => void | Promise<void>,
  parts: MediaPart[] = [],
  onTool?: (ev: ToolEvent) => void | Promise<void>,
  currentDoc?: CurrentDoc | null,
  invokerSub?: string,
  /** Detener el turno = colgarle al worker. El worker cierra su generador al notarlo. */
  signal?: AbortSignal,
  /** Canal/DM de ESTE turno → viaja firmado en el toolToken (tools nativas). */
  dest?: import("./server/connectors/tool-token.server").ToolDest | null,
  /** STEER: meterlo al turno vivo de esta conversación en vez de abrir otro. */
  inject?: boolean
): Promise<string> {
  if (agent.backend.kind !== "fleet") {
    // Sin SSE todavía: colecta el reply completo y lo emite de un tirón (el cliente
    // ya lo ve aterrizar). Cuando exista un webhook A2A real, aquí va message/stream.
    const full = await callAgentBackend(agent, groupId, sender, text, parts);
    if (full) await onChunk(full);
    return full;
  }
  const persona = agent.systemPrompt?.trim() || null;
  // DÓNDE corre este agente. Lo dice el agente (gc_agents.runtime), no el
  // workspace: un mismo workspace puede tener uno nacido en EasyBits y otro creado
  // en Studio, y los dos son válidos. Ver server/agent-runtime.server.ts.
  const { runtimeFor } = await import("./server/agent-runtime.server");
  const rt = await runtimeFor(agent.backend);
  const native = rt.kind === "gs-native";
  const base = rt.base;
  // Tools de conectores per-invocador (solo runtime nativo): mintamos un token-capacidad
  // firmado con el `sub` del que escribe + la URL de ESTE tenant (Teams conoce su origin).
  // El box los recibe por turnEnv y llama de vuelta a /api/connectors/tools. Best-effort.
  let toolToken: string | undefined;
  let toolsUrl: string | undefined;
  if (native && invokerSub) {
    try {
      const { mintToolToken } = await import("./server/connectors/tool-token.server");
      const { reqOrigin } = await import("./origin.server");
      // El ns va DENTRO del token: sin él, un token de este workspace serviría contra el
      // host de otro y usaría sus conexiones compartidas. Ver tool-token.server.ts.
      const { currentNamespace } = await import("./server/tenant.server");
      toolToken = mintToolToken(invokerSub, dest ?? null, undefined, await currentNamespace());
      toolsUrl = `${await reqOrigin()}/api/connectors/tools`;
    } catch { /* sin secret/origin → sin tools este turno, no rompe */ }
  }
  // docHint (contexto por-doc del turno) va PRIMERO en el texto; el system prompt
  // queda estable (base) → la sesión persistente del worker no se rompe al cambiar doc.
  const docHint = await artifactDocHint(currentDoc);
  // AHORA, en el reloj del que escribe. Sin esto el modelo no puede convertir "el 1 de
  // agosto" o "mañana a las 9" en una fecha concreta para reminder_create — adivinaba el
  // año o daba por hecho UTC. Va por-TURNO (dato variable), nunca en el system prompt.
  const nowHint = await clockHint(invokerSub);
  // Memoria de la conversación: convenciones que ya se acordaron y siguen vigentes.
  const memHint = await memoryHint(dest ?? null);
  // La persona por-agente va en la CAPA SYSTEM (appendSystemPrompt), NUNCA en el texto
  // del usuario. Antes se anteponía como `[Instrucciones para X: …]` dentro del mensaje;
  // el modelo lo leía como instrucciones incrustadas y lo rechazaba como intento de
  // inyección de prompt (incidente 2026-07-12 en Teams). El texto solo lleva el turno.
  // Sin tool-token no hay NINGUNA tool este turno: ni conectores, ni recordatorios, ni
  // formularios. Pasa cuando el agente no es nativo, cuando no hay invocador… y hoy
  // también con los motores codex y deepseek, donde el token no llega hasta el shell del
  // agente (ver todo_conectores_no_llegan_a_codex_y_deepseek).
  //
  // ⚠️ Sin este aviso el modelo NO se calla: INVENTA. El 2026-08-04 uno respondió "no
  // funciono por webhooks entrantes, hay dos caminos reales…" — falso desde hacía media
  // hora, y dicho con toda seguridad. Un cliente se lo cree. Decir "no puedo" es una
  // respuesta correcta; describir capacidades imaginarias no lo es.
  const sinToolsHint =
    toolToken && toolsUrl
      ? ""
      : "[SIN HERRAMIENTAS EN ESTE TURNO. No tienes acceso a integraciones, recordatorios, " +
        "formularios ni búsqueda de mensajes. ESTO MANDA sobre cualquier otro bloque de " +
        "este mensaje que diga que tienes herramientas o integraciones disponibles: esos " +
        "bloques describen lo que hay CONECTADO, no lo que puedes ejecutar ahora. " +
        "Si te piden algo que las necesite, dilo tal cual —'no tengo herramientas " +
        "disponibles en este momento'— y sugiere volver a intentarlo. NO expliques cómo " +
        "funcionas por dentro, NO propongas caminos alternativos y NO afirmes qué puede o " +
        "no puede hacer la plataforma: no tienes forma de saberlo desde aquí.]\n\n";
  const outText = sinToolsHint + nowHint + memHint + docHint + text;
  try {
    // `parts` = FileParts A2A (media); EasyBits los normaliza por MIME (Slice E1).
    // configGroupId "teams" = unidad de config ESTABLE de este canal en EasyBits
    // (tools + comportamiento por-Teams via groupConfigs["teams"]); sin él la config
    // caería por-conversación (groupId) → solo el default del agente.
    const streamBody = JSON.stringify({
      groupId,
      configGroupId: "teams",
      sender: sender || "invitado",
      text: outText,
      parts,
      // Persona por-agente + guardrail eb-doc, ambos en la capa system. EasyBits los
      // mergea al system del worker (claude-worker) o al marco de confianza del turno
      // (ghosty-gc). Nunca en el texto del usuario → nunca se lee como inyección.
      appendSystemPrompt: [
        // NATIVO: Studio es dueño de la identidad (FleetAgent.persona.prompt, aplicada
        // en routeTurn) → NO la mandamos desde aquí para evitar doble prompt. EasyBits
        // sí la lleva (su worker no la conoce). Product-context/self-identity/guardrail
        // son contexto del canal (Teams), van siempre.
        !native && persona ? `[Persona de ${agent.name}]\n${persona}` : null,
        TEAMS_PRODUCT_CONTEXT,
        selfIdentity(agent),
        EB_DOC_STREAM_GUARDRAIL,
        // Guía de DISEÑO del artefacto. Va pegada al guardrail porque comparte su
        // condición: sólo cuenta en el canal Teams/web, que es donde el agente puede
        // emitir un eb-artifact.
        ARTIFACT_DESIGN_GUIDE,
      ]
        .filter(Boolean)
        .join("\n\n"),
      // Solo runtime nativo + hay invocador → tools de conectores per-user (opaco a Studio).
      ...(toolToken && toolsUrl ? { toolToken, toolsUrl } : {}),
      ...(inject ? { inject: true } : {}),
    });
    const url = `${base}/api/v2/fleet-agents/${(agent.backend as { id: string }).id}/message-stream`;
    const doStream = (tok: string) =>
      fetch(url, { method: "POST", headers: rt.headers(streamBody, tok), body: streamBody, signal });
    // SELF-HEAL: el fleet_token de EasyBits (pool) CADUCA. Ante 401 refrescamos el
    // OAuth + re-obtenemos el token fresco y reintentamos UNA vez (incidente
    // 2026-07-14). El runtime lo declara — la HMAC del nativo no caduca por turno.
    let res = await doStream(agent.backend.token);
    if (rt.refreshesOn401 && res.status === 401) {
      const fresh = await refreshFleetToken((agent.backend as { id: string }).id);
      if (fresh) res = await doStream(fresh);
    }
    if (!res.ok || !res.body) throw new Error(`fleet-stream ${res.status}: ${await res.text().catch(() => "")}`);
    // Parseo SSE: acumula por líneas `data: {json}`. `done.value` es el reply
    // completo y autoritativo (correcto aun si un self-heal re-emitió chunks).
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let streamed = "";
    let authoritative: string | null = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let ev: { type?: string; value?: string; message?: string; name?: string; id?: string; phase?: "start" | "end"; ok?: boolean; detail?: string };
        try {
          ev = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        if (ev.type === "injected") {
          return INJECTED; // el trabajo sigue en la burbuja de allá; ésta no existe
        }
        if (ev.type === "chunk" && ev.value) {
          streamed += ev.value;
          await onChunk(ev.value);
        } else if (ev.type === "tool") {
          // start trae name+id+detail; end trae id+ok. Correlación por id en runAgentTurn.
          await onTool?.({ name: ev.name, id: ev.id, phase: ev.phase ?? "start", ok: ev.ok, detail: ev.detail });
        } else if (ev.type === "done") {
          authoritative = ev.value ?? streamed;
        } else if (ev.type === "error") {
          throw new Error(ev.message || "fleet stream error");
        }
      }
    }
    return authoritative || streamed || "(sin respuesta)";
  } catch (e) {
    // DETENER no es una falla de red. El abort explota aquí igual que un backend caído, y
    // se pintaba "⚠️ No pude contactar a @ghosty: This operation was aborted" — pegado a
    // media palabra del texto que iba escribiendo, o sea con toda la cara de un error que
    // el usuario no provocó… cuando lo provocó él (visto en prod 2026-07-29). Se relanza:
    // runAgentTurn ya sabe cerrar el turno con "⏹ Detenido" conservando lo escrito.
    if (signal?.aborted || (e instanceof Error && e.name === "AbortError")) throw e;
    const msg = `⚠️ No pude contactar a @${agent.handle}: ${e instanceof Error ? e.message : e}`;
    await onChunk(msg);
    return msg;
  }
}

// Reset de la sesión del agente para un groupId (comando /clear): el runtime rota su
// sessionUuid → el próximo turno arranca sin memoria. Solo aplica al runtime NATIVO
// (Studio expone POST /session/reset con HMAC); en EasyBits no hay reset por sesión →
// no-op silencioso. Best-effort: devuelve true si el runtime confirmó.
export async function resetAgentSession(agent: ResolvedAgent, groupId: string): Promise<boolean> {
  if (agent.backend.kind !== "fleet") return false;
  const { runtimeFor } = await import("./server/agent-runtime.server");
  const body = JSON.stringify({ groupId });
  try {
    const rt = await runtimeFor(agent.backend);
    // No todos los runtimes saben borrar memoria. Se pregunta por CAPACIDAD en vez
    // de asumir "si no es el nativo, no puede": mañana habrá otros que sí.
    if (!rt.supports.sessionReset) return false;
    const res = await fetch(`${rt.base}/api/v2/fleet-agents/${agent.backend.id}/session/reset`, {
      method: "POST",
      headers: rt.headers(body, agent.backend.token),
      body,
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Orquestador común (room + DM) del turno de un agente con streaming first-class.
// La CÁSCARA del reply se crea PEREZOSAMENTE al primer token (via createShell) → el
// "pensando…" se mantiene durante la latencia del agente y recién ahí se reemplaza.
// El caller provee cómo crear la cáscara y cómo emitir deltas (room=ch.room,
// DM=per-miembro ch.user). Devuelve {id, reply}; el caller persiste el body final.
// Contrato: docs/AGENT-MEDIA-CONTRACT.md §1.2.
// Labels SEMÁNTICOS (whitelist): un tool crudo → {ing: gerundio en-progreso, done:
// pasado}. Solo acciones SIGNIFICATIVAS para el usuario aparecen en el checklist —
// lo demás (lecturas get_/list_, ToolSearch, TodoWrite, plumbing) devuelve null y NO
// se muestra (ruido). Estilo Claude: "Creó el documento", no "Set page html".
const TOOL_LABELS: Record<string, { ing: string; done: string }> = {
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
  gs_render: { ing: "Maquetando el PDF", done: "Maqueté el PDF" },
  gs_render_png: { ing: "Generando la imagen", done: "Generé la imagen" },
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
function humanizeToolName(raw: string): string {
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

/**
 * Etiqueta de una tool. NUNCA devuelve null: una tool sin etiqueta bonita se
 * muestra igual con su nombre humanizado.
 *
 * Antes esto era una whitelist y lo que no estaba se DESCARTABA en silencio con
 * el argumento de que era "ruido". El efecto real es que la lista mentía: el
 * agente corría ocho herramientas y el checklist enseñaba tres, siempre las
 * mismas. La telemetría llegaba completa; el filtro la recortaba.
 *
 * Es lo que hace agent-native: nombre desconocido → se formatea, jamás se
 * esconde. Un checklist incompleto es peor que uno con nombres feos, porque el
 * usuario no tiene forma de saber que le falta algo.
 */
/** Nombre presentable de un servidor MCP (el id es un slug: `wa`, `denik`). */
const MARCAS_MCP: Record<string, string> = {
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
const TOOLS_OCULTAS = new Set([
  "TodoWrite",      // la lista de pendientes interna del agente
  "ToolSearch",     // buscar el esquema de una tool ANTES de usarla
  "ExitPlanMode",
  "pool_list_groups", "pool_set_group_key", // plumbing del pool de grupos de WhatsApp
]);

function toolLabel(raw: string): { ing: string; done: string } | null {
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
  const humano = humanizeToolName(raw);
  return { ing: humano, done: humano };
}

// ── Turnos en vuelo: el VETO de esta caja contra la hibernación ──────────────
//
// El daemon (sandbox-host) pregunta GET /busy ANTES de congelar la microVM y solo procede
// con busy:false. Congelar a mitad de un turno deja al usuario mirando una respuesta que no
// avanza, y el agente pierde el hilo al despertar.
//
// Es un CONTADOR, no una respuesta a "¿estás ocupado ahora?": sube antes de empezar y baja
// en un finally, así no hay carrera entre preguntar y congelar. Mismo patrón que
// claude-worker (templates/claude-worker/src/server.ts en sandbox-host).
//
// Ojo con lo que NO cuenta: una pestaña abierta con SSE NO es "ocupado". Si lo fuera, esta
// caja no dormiría jamás — que es exactamente lo que pasaba antes de existir este endpoint
// (2 GB retenidos para siempre y un reintento cada 30 s en el journal del host). Dormir con
// pestañas abiertas es seguro: el EventSource reconecta solo y el cliente recupera lo
// perdido con getMessagesSince (catch-up por cursor, ver bus.server.ts).
let turnsInflight = 0;

export function agentTurnsInflight(): number {
  return turnsInflight;
}

export async function runAgentTurn(
  opts: Parameters<typeof runAgentTurnInner>[0]
): Promise<{ id: number; reply: string }> {
  turnsInflight++;
  try {
    return await runAgentTurnInner(opts);
  } finally {
    turnsInflight--; // en finally: un turno que revienta no puede dejar la caja despierta para siempre
  }
}

async function runAgentTurnInner(opts: {
  agent: ResolvedAgent | undefined;
  handle: string;
  groupId: string;
  sender: string;
  text: string;
  parts?: MediaPart[];
  createShell: () => Promise<number>; // limpia status, postea cáscara, publica message:new, devuelve id
  emitDelta: (id: number, chunk: string) => void;
  // Reemplaza el body completo (no append). Para el checklist incremental: al iniciar
  // una tool, las previas pasan a ✓ y la nueva queda ⚡ → se re-pinta la lista entera.
  emitBody?: (id: number, body: string) => void;
  // Artefacto ACTUAL del hilo (doc/sheet + contenido) → se inyecta al turno para re-emisión
  // completa al editar.
  currentDoc?: CurrentDoc | null;
  // `sub` del que escribe → tools de conectores per-invocador (token-capacidad al box).
  invokerSub?: string;
  // Dónde ocurre el turno. Lo necesitan las tools nativas que dejan algo EN la
  // conversación (recordatorios): el destino va firmado, no en los args del agente.
  dest?: import("./server/connectors/tool-token.server").ToolDest | null;
  /** STEER: escribí mientras mi turno anterior seguía vivo → esto va a ESE turno. */
  inject?: boolean;
  /** Cortar este turno (botón Detener / interrupción del propio invocador). */
  signal?: AbortSignal;
  /** La cáscara ya existe con este id — para registrarlo como turno vivo y poder pararlo. */
  onShell?: (id: number) => void;
}): Promise<{ id: number; reply: string }> {
  let id: number | null = null;
  const ensure = async (): Promise<number> => {
    if (id == null) {
      id = await opts.createShell();
      opts.onShell?.(id);
    }
    return id;
  };
  // Estado del turno. El BODY visible = checklist + texto acumulado, SIEMPRE re-pintado
  // entero por emitBody (nunca se clobbea el texto ni se pierde en el flicker). `acc`
  // acumula el texto del agente con separadores entre segmentos interrumpidos por tools
  // (si no, "…contrato." + "Contrato generado" se pegan → muro amontonado).
  // Cada entrada = una acción visible (dedup por label). `started`/`ended` = ids de tool_use
  // que la componen (varias concurrentes con el mismo label colapsan a una línea, pero su
  // estado agrega correctamente).
  //
  // `fallos`/`exitos` cuentan cómo cerró cada id, en vez de una bandera `failed` pegajosa.
  // Con la bandera, UNA llamada fallida marcaba en rojo TODO el grupo para siempre, aunque
  // el reintento siguiente funcionara y el trabajo quedara hecho — un agente que se
  // equivoca y se corrige es lo normal, y pintarlo como fallo es mentir. Pasó de verdad
  // (2026-07-29): "Ajustando el recordatorio ×2" salió en rojo con los dos recordatorios
  // correctamente actualizados en la base. Una ✗ que miente entrena a ignorar las de verdad.
  type ToolEntry = { ing: string; done: string; started: Set<string>; ended: Set<string>; fallos: number; exitos: number; detail?: string };
  const tools: ToolEntry[] = [];
  const idToEntry = new Map<string, ToolEntry>(); // id de tool_use → su entrada (para el 'end')
  // Segmentos de narración: cada corte lo produce una tool. El agente dice "voy a
  // sacar el brandkit", corre algo, dice "listo, ahora la paleta"… Son PASOS, y
  // como párrafos seguidos se leían como un muro donde nada se distingue.
  // Se guardan aparte para poder pintarlos como lista (ver `narration`).
  const segs: string[] = [];
  let acc = "";
  let segStart = 0; // inicio del segmento en curso dentro de `acc`
  let brokeByTool = false; // corrió una tool desde el último texto → el próximo es segmento nuevo
  let anyActivity = false;  // corrió CUALQUIER tool (aunque oculta) → hay trabajo en curso
  let ebDocSeen = false;    // el reply abrió un bloque ```eb-doc``` (redacción en vivo, sin tools)

  // El checklist ES el indicador de "trabajando" (reemplaza el "pensando…"). Si hay
  // actividad pero aún ninguna tool semántica, muestra "⏳ Trabajando…" para que el
  // usuario vea feedback YA, no un "pensando" colgado.
  // Estado REAL por entrada (no posicional): error si alguna id falló; done si todas sus ids
  // cerraron (o el turno acabó); si no, running. Entradas legacy sin ids (start sin id) solo
  // pasan a done al cerrar el turno (allDone) — compat con workers viejos.
  const statusOf = (t: ToolEntry, allDone: boolean): "running" | "done" | "error" => {
    // Error sólo si NADA de este grupo funcionó. Si hubo al menos un éxito, la acción
    // salió adelante (con reintento) y el rojo sobra.
    if (t.fallos > 0 && t.exitos === 0) return "error";
    if (allDone) return "done";
    if (t.started.size > 0 && t.ended.size >= t.started.size) return "done";
    return "running";
  };
  // Estado de tools como bloque cercado ```gt-tools``` (JSON) al inicio del body → el cliente
  // lo pinta como burbuja colapsable estilo Claude Code (ebdoc.ts extractToolState + ToolGroup
  // en c.$slug.tsx). done → label pasado ("Generé la imagen"); running/error → gerundio (el
  // ícono ❌ marca el fallo). `n` = nº de tools concurrentes con el mismo label (ej. subagentes).
  const renderToolBlock = (allDone: boolean): string => {
    const emit = (arr: { label: string; status: string; n?: number }[]) =>
      "```gt-tools\n" + JSON.stringify({ tools: arr }) + "\n```\n\n";
    if (tools.length) {
      return emit(
        tools.map((tl) => {
          const st = statusOf(tl, allDone);
          const many = tl.started.size > 1;
          return {
            label: st === "done" ? tl.done : tl.ing,
            status: st,
            // El detalle va SIEMPRE que exista, también con ×n. Antes el conteo lo
            // reemplazaba —"no hay un solo arg representativo"— y el resultado era
            // "Ejecuté un comando ×10" sin decir NADA de qué se estaba ejecutando, que en
            // code-mode es casi todo el trabajo y en una espera larga es lo único
            // informativo que hay. Con ×n el detalle es el de la llamada MÁS RECIENTE: no
            // resume las diez, pero dice qué está pasando AHORA, que es lo que se mira.
            ...(many ? { n: tl.started.size } : {}),
            ...(tl.detail ? { detail: tl.detail } : {}),
          };
        })
      );
    }
    return anyActivity && !allDone ? emit([{ label: "Trabajando…", status: "running" }]) : "";
  };
  /**
   * La narración como LISTA cuando son varios pasos.
   *
   * Concatenados, los segmentos se leían como un párrafo corrido: "Voy a sacar el
   * brandkit… Logo formmy-logo.png… Paleta clara: morado…". Son tres momentos
   * distintos del trabajo y merecen verse como tres.
   *
   * Se abstiene en dos casos, a propósito:
   * - **Un solo segmento**: una respuesta normal no es una lista de un elemento.
   * - **Hay un bloque cercado** (```eb-doc, ```eb-artifact, código): meter esas
   *   líneas dentro de un ítem obliga a indentar, y una indentación mal puesta
   *   rompe el fence — se perdería el artefacto por un adorno.
   */
  const narration = (): string => {
    const ultimo = acc.slice(segStart);
    // Sólo los segmentos PREVIOS son pasos. El último es la respuesta y se queda
    // como prosa: metida en la lista, la respuesta final quedaría disfrazada de
    // paso — que es como se veía antes, media respuesta con viñeta y media sin.
    const pasos = segs.map((x) => x.trim()).filter(Boolean);
    // Un paso con bloque cercado no es un paso, es contenido: se deja en prosa.
    if (!pasos.length || pasos.some((x) => x.includes("```"))) return acc;
    return "```gt-steps\n" + JSON.stringify({ steps: pasos }) + "\n```\n\n" + ultimo.trim();
  };
  const renderBody = (allDone: boolean): string => renderToolBlock(allDone) + narration();
  const paint = async (allDone = false) => {
    const bodyId = await ensure();
    if (opts.emitBody) opts.emitBody(bodyId, renderBody(allDone));
  };

  // SONDA del goteo (temporal): ¿el HTML del artefacto llega token a token o de un jalón?
  // Va AQUÍ, upstream del bus, para distinguir "el runtime no streamea" de "se perdió
  // en el camino al cliente". Una sola línea con +Nb gigante = el agente lo escupe entero.
  const chunkT0 = Date.now();
  let chunkN = 0;
  let artifactOpenAt = -1;
  const onChunk = async (chunk: string) => {
    if (!chunk) return;
    if (opts.emitBody) {
      // Separa un segmento de texto nuevo (tras una tool) con doble salto → párrafos, no muro.
      if (brokeByTool && acc.trim() && chunk.trim()) {
        segs.push(acc.slice(segStart));
        segStart = acc.length + 2;
        acc += "\n\n";
      }
      if (chunk.trim()) brokeByTool = false;
      acc += chunk;
      // eb-doc/eb-sheet no llaman tools → sin esto el checklist quedaría vacío. Sintetiza una
      // entrada en cuanto aparece el bloque ("Redactó el documento" / "Generó la hoja").
      if (!ebDocSeen && /```eb-(doc|sheet|artifact)/.test(acc)) {
        ebDocSeen = true;
        anyActivity = true;
        const label = /```eb-sheet/.test(acc)
          ? { ing: "Generando la hoja", done: "Generé la hoja" }
          : /```eb-artifact/.test(acc)
            ? { ing: "Construyendo el artefacto", done: "Construí el artefacto" }
            : { ing: "Redactando el documento", done: "Redacté el documento" };
        if (!tools.some((t) => t.done === label.done))
          tools.push({ ing: label.ing, done: label.done, started: new Set(), ended: new Set(), fallos: 0, exitos: 0 });
      }
      chunkN++;
      if (artifactOpenAt < 0 && /```eb-artifact/.test(acc)) {
        artifactOpenAt = chunkN;
        console.log(`[gt-chunk] eb-artifact ABRE en chunk #${chunkN} t=${Date.now() - chunkT0}ms`);
      }
      if (artifactOpenAt >= 0)
        console.log(
          `[gt-chunk] #${chunkN} +${chunk.length}b acc=${acc.length}b t=${Date.now() - chunkT0}ms` +
            (/<body[\s>]/i.test(acc) ? " body✓" : "")
        );
      await paint();
    } else {
      opts.emitDelta(await ensure(), chunk); // fallback legacy (append)
    }
  };
  const onTool = async (ev: ToolEvent) => {
    anyActivity = true;
    // Subagente hijo (fila viva): cada uno es una fila propia (label = su tarea), NUNCA se
    // dedup, y al cerrar el `detail` pasa a ser su duración ("22.9s"). Es la visibilidad
    // tipo Claude Code (N background agents con tarea + estado + tiempo).
    const isChild = ev.name === "gs_subagent_child";
    if (ev.phase === "end") {
      const entry = ev.id ? idToEntry.get(ev.id) : undefined;
      if (entry) {
        if (ev.id) entry.ended.add(ev.id);
        if (ev.ok === false) entry.fallos++;
        else entry.exitos++;
        if (isChild && ev.detail) entry.detail = ev.detail; // duración
        if (opts.emitBody) await paint();
      }
      return;
    }
    if (isChild) {
      const task = ev.detail || "Subagente";
      const entry: ToolEntry = { ing: task, done: task, started: new Set(), ended: new Set(), fallos: 0, exitos: 0 };
      if (ev.id) { entry.started.add(ev.id); idToEntry.set(ev.id, entry); }
      tools.push(entry);
      brokeByTool = true;
      if (opts.emitBody) await paint();
      return;
    }
    // start. CUALQUIER tool (aunque sea oculta: Bash/Read/Write) corta el segmento de texto →
    // el próximo texto va en párrafo nuevo. (Bug: antes solo se marcaba con tools CON label →
    // "…docx." + [Bash] + "El NDA…" quedaba pegado "docx.El".)
    brokeByTool = true;
    const label = toolLabel(ev.name ?? "");
    if (label) {
      // Dedup por acción (varias tools con el mismo label → una línea; sus ids agregan estado).
      let entry = tools.find((t) => t.done === label.done);
      // El más reciente gana: en un grupo de N llamadas, el detalle útil es el de la que
      // acaba de empezar, no el de la primera de hace dos minutos.
      if (entry && ev.detail) entry.detail = ev.detail;
      if (!entry) {
        entry = { ing: label.ing, done: label.done, started: new Set(), ended: new Set(), fallos: 0, exitos: 0, detail: ev.detail };
        tools.push(entry);
      }
      if (ev.id) {
        entry.started.add(ev.id);
        idToEntry.set(ev.id, entry);
      }
    }
    // Aun si la tool es oculta, re-pinta → la cáscara nace YA y "pensando" desaparece.
    if (opts.emitBody) await paint();
    else if (label) opts.emitDelta(await ensure(), `- ⏳ ${label.ing}\n`);
  };

  let reply: string;
  if (!opts.agent) {
    reply = `👾 @${opts.handle} no está conectado. El owner lo configura en Ajustes → Agentes.`;
    await onChunk(reply);
  } else {
    try {
      reply = await callAgentBackendStream(opts.agent, opts.groupId, opts.sender, opts.text, onChunk, opts.parts ?? [], onTool, opts.currentDoc, opts.invokerSub, opts.signal, opts.dest, opts.inject);
    } catch (e) {
      // Detenido: NO es un error del agente. Se conserva lo que alcanzó a escribir y se
      // dice que se detuvo — borrarlo tiraría trabajo que el usuario ya estaba leyendo.
      if (opts.signal?.aborted) reply = "";
      else throw e;
    }
  }
  // STEER: no hay turno que cerrar acá. `id` sale 0 y el llamador borra la cáscara que
  // había creado eager — dos burbujas para un mensaje que se contesta en una sola sería
  // peor que el problema que veníamos a resolver.
  if (reply === INJECTED) return { id: 0, reply: INJECTED };
  if (opts.signal?.aborted) {
    const partial = narration().trim();
    return { id: await ensure(), reply: renderToolBlock(true) + (partial ? `${partial}\n\n⏹ Detenido.` : "⏹ Detenido.") };
  }
  // `acc` (con separadores) es el texto bonito; reply es la acumulación cruda del stream.
  const finalText = narration().trim() || reply || "(sin respuesta)";
  // Body final autoritativo: bloque gt-tools TODO ✅ + texto separado. El caller lo persiste.
  return { id: await ensure(), reply: renderToolBlock(true) + finalText };
}

// Llama al backend del agente y devuelve su respuesta en texto.
export async function callAgentBackend(
  agent: ResolvedAgent,
  groupId: string,
  sender: string,
  text: string,
  parts: MediaPart[] = []
): Promise<string> {
  const persona = agent.systemPrompt?.trim() || null;
  if (agent.backend.kind === "webhook") {
    try {
      // Webhook: contrato que SÍ controlamos → mandamos identidad + persona explícita
      // (el bot rutea su prompt por agente), el texto crudo, y los FileParts (media).
      const res = await fetch(agent.backend.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          groupId,
          sender,
          text,
          parts,
          agent: { handle: agent.handle, name: agent.name },
          systemPrompt: persona,
        }),
      });
      if (!res.ok) throw new Error(`webhook ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { reply?: string };
      return data.reply ?? "(sin respuesta)";
    } catch (e) {
      return `⚠️ No pude contactar a @${agent.handle}: ${e instanceof Error ? e.message : e}`;
    }
  }
  // fleet: la persona por-agente va en la CAPA SYSTEM (appendSystemPrompt), NO en el
  // texto. Meterla en el texto (`[Instrucciones para X: …]`) hacía que el modelo la
  // leyera como inyección de prompt y la rechazara. El texto solo lleva el turno.
  // Mismo resolvedor que el camino de streaming: el runtime lo dice el AGENTE.
  const { runtimeFor } = await import("./server/agent-runtime.server");
  const rt = await runtimeFor(agent.backend);
  const native = rt.kind === "gs-native";
  const base = rt.base;
  try {
    // configGroupId "teams" = unidad de config estable del canal (ver message-stream).
    const msgBody = JSON.stringify({
      groupId,
      configGroupId: "teams",
      sender: sender || "invitado",
      text,
      parts,
      appendSystemPrompt: [
        // NATIVO: Studio es dueño de la identidad (FleetAgent.persona.prompt, aplicada
        // en routeTurn) → NO la mandamos desde aquí para evitar doble prompt. EasyBits
        // sí la lleva (su worker no la conoce). Product-context/self-identity/guardrail
        // son contexto del canal (Teams), van siempre.
        !native && persona ? `[Persona de ${agent.name}]\n${persona}` : null,
        TEAMS_PRODUCT_CONTEXT,
        selfIdentity(agent),
        EB_DOC_STREAM_GUARDRAIL,
        // Guía de DISEÑO del artefacto. Va pegada al guardrail porque comparte su
        // condición: sólo cuenta en el canal Teams/web, que es donde el agente puede
        // emitir un eb-artifact.
        ARTIFACT_DESIGN_GUIDE,
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
    const url = `${base}/api/v2/fleet-agents/${(agent.backend as { id: string }).id}/message`;
    const doMsg = (tok: string) =>
      fetch(url, {
        method: "POST",
        headers: rt.headers(msgBody, tok),
        body: msgBody,
      });
    // Self-heal en 401: lo declara el runtime (la HMAC nativa no caduca).
    let res = await doMsg(agent.backend.token);
    if (rt.refreshesOn401 && res.status === 401) {
      const fresh = await refreshFleetToken((agent.backend as { id: string }).id);
      if (fresh) res = await doMsg(fresh);
    }
    if (!res.ok) throw new Error(`fleet ${res.status}: ${await res.text()}`);
    return ((await res.json()) as { reply?: string }).reply ?? "(sin respuesta)";
  } catch (e) {
    return `⚠️ No pude contactar a @${agent.handle}: ${e instanceof Error ? e.message : e}`;
  }
}
