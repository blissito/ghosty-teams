/**
 * ghosty-collab — servidor Yjs (Hocuspocus) para la co-edición de documentos de GTeams.
 * Sidecar co-locado en el team VM: el estado por-documento y las conexiones WS pegajosas
 * viven donde vive el equipo.
 *
 *   WS   ws://<box>:9400              → co-edición Yjs (BlockNote)
 *   GET  http://<box>:9400/health     → 200 sin abrir room (readiness barato)
 *   ANY  http://<box>:9400/threads/:d → hilos de comentarios para el AGENTE (Bearer SECRET,
 *                                       sólo loopback desde Teams; listar/responder/resolver)
 *
 * Auth (onAuthenticate): el cliente manda un TICKET firmado que minteó GTeams
 *   (`collab-ticket.server.ts`), con documento + identidad + rol. Se verifica AQUÍ con el
 *   mismo COLLAB_SECRET — sin llamada HTTP por conexión. Rol `view` → `readOnly: true`:
 *   en Yjs el solo-lectura tiene que aplicarse en el servidor porque el cliente siempre
 *   puede intentar escribir.
 * Persistencia (extension-database): estado binario Yjs contra GTeams
 *   (`/api/collab/:docId/state`), que lo guarda en el sobre del documento. Sobrevive al
 *   suspend/destroy de la caja.
 *
 * ⚠️ Se queda CHIQUITO a propósito: firma, bytes, y un Y.Map de hilos que mueve sin
 * interpretar. Bloques, anclas y tracked-changes son estructura DENTRO del Y.Doc — viven
 * en los clientes. Si este archivo empieza a entender de DOCUMENTOS (parsear bloques,
 * decidir permisos, versionar), está mal.
 *
 * ENV (lo inyecta el host en /etc/collab-svc-runtime/.env vía startAgent):
 *   COLLAB_PORT (default 9400) · GTEAMS_BASE_URL (default el app local) · COLLAB_SECRET
 */
import crypto from "node:crypto";
import * as Y from "yjs";
import { Server } from "@hocuspocus/server";
import { Database } from "@hocuspocus/extension-database";

const PORT = Number(process.env.COLLAB_PORT || 9400);
// El app de Teams corre en la MISMA VM (unit ghosty-teams, :3000): por defecto se le
// habla por loopback, sin salir a la red ni depender del DNS público.
const BASE = (process.env.GTEAMS_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const SECRET = process.env.COLLAB_SECRET || "";

const authHeaders = { authorization: `Bearer ${SECRET}` };

// Verifica el ticket `<payloadB64Url>.<sigB64Url>` (HMAC-SHA256). Espejo exacto de
// `verifyCollabTicket` en GTeams. Devuelve el payload o null.
function verifyTicket(token, documentName) {
  if (!SECRET) return null;
  const [payload, sig] = String(token || "").split(".");
  if (!payload || !sig) return null;

  const expected = crypto
    .createHmac("sha256", SECRET)
    .update(payload)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  let t;
  try {
    t = JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch {
    return null;
  }
  if (!t?.doc || !t.exp || t.exp < Math.floor(Date.now() / 1000)) return null;
  if (String(t.doc) !== String(documentName)) return null;
  return t;
}

function leerBody(request) {
  return new Promise((resolve, reject) => {
    let d = "";
    request.on("data", (c) => {
      d += c;
      if (d.length > 64_000) reject(new Error("body demasiado grande"));
    });
    request.on("end", () => resolve(d || "{}"));
    request.on("error", reject);
  });
}

// Abre el documento por la vía OFICIAL de Hocuspocus (openDirectConnection): carga el
// estado si nadie está conectado, y si sí lo está, entra al MISMO Y.Doc vivo — el cambio
// se difunde a los que están escribiendo y se persiste con el flujo normal. Escribir el
// snapshot a mano en su lugar habría pisado a quien estuviera dentro.
async function conHilos(documentName, fn) {
  const conn = await server.openDirectConnection(documentName);
  try {
    let out;
    await conn.transact((doc) => {
      out = fn(doc.getMap("threads"));
    });
    return out;
  } finally {
    await conn.disconnect();
  }
}

// Un comentario en el formato que ya usa BlockNote (YjsThreadStore): no se inventa nada,
// se escribe la MISMA estructura que escribiría el editor. El `body` es un documento
// BlockNote — un párrafo basta.
function comentarioYMap({ id, userId, texto }) {
  const c = new Y.Map();
  const ahora = Date.now();
  c.set("id", id);
  c.set("userId", userId);
  c.set("createdAt", ahora);
  c.set("updatedAt", ahora);
  c.set("body", [
    {
      id: crypto.randomUUID(),
      type: "paragraph",
      props: {},
      content: [{ type: "text", text: texto, styles: {} }],
      children: [],
    },
  ]);
  c.set("reactionsByUser", new Y.Map());
  c.set("metadata", undefined);
  return c;
}

function textoDe(body) {
  if (!Array.isArray(body)) return "";
  return body
    .map((b) => (Array.isArray(b?.content) ? b.content.map((i) => i?.text ?? "").join("") : ""))
    .join("\n")
    .trim();
}

function leerHilo(t) {
  const comments = t.get("comments");
  return {
    id: t.get("id"),
    resolved: !!t.get("resolved"),
    resolvedBy: t.get("resolvedBy") ?? null,
    createdAt: t.get("createdAt") ?? null,
    comments: (comments ? comments.toArray() : []).map((c) => ({
      id: c.get("id"),
      userId: c.get("userId"),
      createdAt: c.get("createdAt") ?? null,
      text: textoDe(c.get("body")),
      deleted: !!c.get("deletedAt"),
    })),
  };
}

// El vocabulario es deliberadamente corto: listar, responder y resolver. ABRIR un hilo
// nuevo NO está aquí porque el ancla de un comentario es una marca sobre el texto, y eso
// necesita un editor montado — el sidecar no tiene ninguno. Ghosty responde y cierra
// hilos; abrirlos es de quien está leyendo el documento.
function operarHilos(hilos, method, body) {
  if (method === "GET") {
    return { threads: [...hilos.values()].map(leerHilo) };
  }
  const op = String(body.op || "");
  const hilo = body.threadId ? hilos.get(String(body.threadId)) : null;
  if (op !== "list" && !hilo) throw new Error("hilo no encontrado");

  if (op === "list") return { threads: [...hilos.values()].map(leerHilo) };

  if (op === "reply") {
    const texto = String(body.text || "").trim();
    if (!texto) throw new Error("falta el texto");
    const comentarios = hilo.get("comments");
    if (!comentarios) throw new Error("hilo corrupto");
    const id = crypto.randomUUID();
    comentarios.push([comentarioYMap({ id, userId: String(body.userId || "agent"), texto })]);
    hilo.set("updatedAt", Date.now());
    return { ok: true, commentId: id };
  }

  if (op === "resolve" || op === "unresolve") {
    const resolver = op === "resolve";
    hilo.set("resolved", resolver);
    hilo.set("resolvedUpdatedAt", Date.now());
    hilo.set("resolvedBy", resolver ? String(body.userId || "agent") : undefined);
    hilo.set("updatedAt", Date.now());
    return { ok: true, resolved: resolver };
  }

  throw new Error(`operación desconocida: ${op}`);
}

// Quiénes entraron a cada sala, acumulado durante la sesión. El `onDisconnect` que corta
// la versión ya no tiene a nadie a quien preguntarle: para cuando la sala se vacía, las
// conexiones ya se fueron. Se apunta al autenticar y se vacía al cerrar.
const participantes = new Map(); // documentName -> Set<sub>

// documentName -> namespace del tenant, sacado del TICKET al autenticar.
//
// ⚠️ Existe por una fuga que estuvo ACTIVA hasta el 2026-08-04: este sidecar llama a Teams
// por loopback (`BASE` = 127.0.0.1:3000), y sin subdominio Teams no puede resolver el
// tenant y caía a `SQLD_NAMESPACE` — el namespace de un workspace REAL. O sea que el
// estado Yjs de TODOS los workspaces se leía y escribía contra la base de ese cliente.
//
// El `Bearer COLLAB_SECRET` no ayuda: es un secreto GLOBAL, igual para todos los tenants.
// Lo único que distingue un workspace de otro es el ticket, así que el ns viaja desde ahí
// hasta cada llamada, en el header `x-gt-ns`.
const nsDeDoc = new Map(); // documentName -> ns

/** Headers hacia Teams para ESTE documento. Sin ns, Teams responde 400 (no adivina). */
function hdrs(documentName, extra = {}) {
  const ns = nsDeDoc.get(documentName);
  if (!ns) console.error(`[collab] sin ns para ${documentName} — Teams va a rechazar`);
  return { ...authHeaders, ...(ns ? { "x-gt-ns": ns } : {}), ...extra };
}

const server = Server.configure({
  port: PORT,
  address: "0.0.0.0",

  // Readiness HTTP (el host sondea GET /health, no WS). resolve = sigue Hocuspocus;
  // reject = ya respondimos nosotros.
  async onRequest({ request, response }) {
    const path = (request.url || "").split("?")[0];

    if (path === "/health") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
      return Promise.reject(); // rechazar = ya respondimos nosotros
    }

    // Diagnóstico de conexiones. Existe porque "hay gente conectada que no está" sólo se
    // puede resolver mirando, no discutiendo: dice cuántos sockets hay, cuántos documentos
    // abiertos y cuántas conexiones tiene cada uno.
    if (path === "/debug/conns") {
      if ((request.headers.authorization || "") !== authHeaders.authorization) {
        response.writeHead(401).end("unauthorized");
        return Promise.reject();
      }
      // QUIÉN hay en cada documento, no sólo cuántos. Un conteo no distingue "cuatro
      // personas" de "una persona con cuatro pestañas colgadas", que es justo la
      // pregunta cuando alguien aparece multiplicado en el rail de presencia.
      const docs = [];
      server.documents.forEach((doc, nombre) => {
        const quienes = [];
        try {
          doc.connections.forEach(({ connection }) => {
            const u = connection?.context?.user;
            quienes.push({
              sub: u?.sub ?? "?",
              nombre: u?.name ?? "?",
              readOnly: !!connection?.readOnly,
            });
          });
        } catch (e) {
          quienes.push({ error: e?.message });
        }
        docs.push({ doc: nombre, conexiones: doc.getConnectionsCount(), quienes });
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          sockets: server.server?.webSocketServer?.clients?.size ?? null,
          conexiones: server.getConnectionsCount(),
          documentos: server.getDocumentsCount(),
          docs,
        }),
      );
      return Promise.reject();
    }

    // Hilos de comentarios para el AGENTE. Ghosty no tiene navegador: sin esto podría
    // escribir el documento pero no participar en su conversación, y una capacidad que
    // sólo existe en la UI está incompleta.
    //
    // Va por HTTP autenticado con el mismo COLLAB_SECRET y sólo escucha en la VM: quien
    // llama es Teams por loopback. El sidecar sigue sin interpretar NADA — mueve entradas
    // de un Y.Map. Quién puede comentar lo decidió Teams antes de llamar.
    const m = path.match(/^\/threads\/(.+)$/);
    if (m) {
      const doc = decodeURIComponent(m[1]);
      if ((request.headers.authorization || "") !== authHeaders.authorization) {
        response.writeHead(401).end("unauthorized");
        return Promise.reject();
      }
      try {
        const body = request.method === "GET" ? {} : JSON.parse(await leerBody(request));
        const out = await conHilos(doc, (hilos) => operarHilos(hilos, request.method, body));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(out));
      } catch (e) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: e?.message || "error" }));
      }
      return Promise.reject();
    }
  },

  // El cliente (HocuspocusProvider) manda { token }. documentName = documentId.
  async onAuthenticate({ documentName, token, connection }) {
    const t = verifyTicket(token, documentName);
    if (!t) throw new Error("unauthorized");
    // ⚠️ El solo-lectura se marca en `connection`, NO en lo que devuelve el hook: lo que
    // se retorna es el `context`, y ponerle `readOnly` ahí no hace nada — el peer seguía
    // escribiendo y el E2E lo cachó. Hocuspocus lee `connection.readOnly` al construir la
    // Connection y descarta los updates entrantes de esa conexión.
    // `comment` SÍ escribe: el ancla de un hilo es una marca sobre el texto, así que
    // abrir un comentario toca el documento. Lo que lo separa de `edit` es la
    // autorización del thread store y el editor no editable — ambos del lado del cliente.
    // LÍMITE CONOCIDO: un peer `comment` con un cliente hecho a mano podría editar el
    // cuerpo. `view` sí queda blindado aquí. Cerrarlo del todo pide mover las escrituras
    // de hilos a un endpoint (RESTYjsThreadStore), que es a donde apunta esto si hace falta.
    connection.readOnly = t.role === "view";
    // El tenant, ANTES de que Hocuspocus cargue el documento: `fetch` del Database corre
    // después de este hook y ya necesita saber a qué workspace preguntarle.
    if (t.ns) nsDeDoc.set(documentName, String(t.ns));
    // Sólo cuenta como autor quien PUEDE escribir: haber mirado un documento no es haberlo
    // co-editado, y firmar una versión con un lector sería mentira.
    if (t.role !== "view" && t.sub) {
      if (!participantes.has(documentName)) participantes.set(documentName, new Set());
      participantes.get(documentName).add(String(t.sub));
    }
    // El return es el `context` de los hooks (auditoría, comentarios más adelante).
    return {
      user: { sub: t.sub, name: t.name, avatar: t.avatar, color: t.color },
      role: t.role,
    };
  },

  // Se fue el último → la sesión de co-edición terminó. Teams corta una VERSIÓN con lo
  // que quedó escrito (ver /api/collab/:docId/session-end). Sin esto una tarde entera de
  // co-edición no deja historial: `yUpdate` es estado y se sobrescribe.
  //
  // El sidecar no decide NADA: sólo avisa. Quién es el dueño, si cambió algo y cómo se
  // versiona es cosa de Teams — aquí seguimos sin entender de documentos.
  async onDisconnect({ documentName, clientsCount }) {
    if (clientsCount > 0) return;
    const subs = [...(participantes.get(documentName) ?? [])];
    participantes.delete(documentName);
    await fetch(`${BASE}/api/collab/${encodeURIComponent(documentName)}/session-end`, {
      method: "POST",
      headers: hdrs(documentName, { "content-type": "application/json" }),
      body: JSON.stringify({ participants: subs }),
    }).catch((e) => console.error("[collab] session-end failed:", e?.message));
  },

  extensions: [
    new Database({
      // Estado previo, o null si el doc nunca se co-editó (el editor lo siembra desde
      // los bloques del documento).
      fetch: async ({ documentName }) => {
        const res = await fetch(
          `${BASE}/api/collab/${encodeURIComponent(documentName)}/state`,
          { headers: hdrs(documentName) },
        );
        if (!res.ok || res.status === 204) return null;
        const buf = new Uint8Array(await res.arrayBuffer());
        return buf.byteLength ? buf : null;
      },
      // Hocuspocus lo llama debounced tras las ediciones. Es el ÚNICO que persiste:
      // que cada cliente escribiera su propio snapshot era una carrera.
      store: async ({ documentName, state }) => {
        await fetch(`${BASE}/api/collab/${encodeURIComponent(documentName)}/state`, {
          method: "PUT",
          headers: hdrs(documentName, { "content-type": "application/octet-stream" }),
          body: state,
        }).catch((e) => console.error("[collab] store failed:", e?.message));
      },
    }),
  ],
});

server.listen();
console.log(`[ghosty-collab] Hocuspocus escuchando en :${PORT} (base=${BASE})`);

// HEARTBEAT. Hocuspocus 2.15 NO hace ping/pong: su opción `timeout` sólo cubre el
// handshake inicial. Un cliente que muere sin cerrar —laptop suspendida, wifi caído,
// proceso matado— deja un socket half-open que el servidor no detecta NUNCA.
//
// No es cosmético: la versión se corta cuando la sala se queda sin nadie
// (`onDisconnect` con `clientsCount === 0`), así que un socket zombi bloquea el
// historial y la firma de autoría del documento para siempre.
//
// Receta estándar de `ws`: marcar vivo en cada pong, terminar al que no contestó la
// ronda anterior. 30s da margen de sobra a una red lenta sin dejar zombis colgados.
// ⚠️ El WebSocketServer NO cuelga del objeto que devuelve `Server.configure()`: vive en
// `server.server.webSocketServer` y sólo EXISTE DESPUÉS de `listen()`. Buscarlo en
// `server.webSocketServer` devuelve undefined y el latido queda iterando la nada — sin
// error y sin efecto. Comprobado contra la caja: `clients` es un Set de verdad.
const sockets = () => server.server?.webSocketServer?.clients ?? [];

const LATIDO_MS = 30_000;
setInterval(() => {
  for (const ws of sockets()) {
    if (ws.__vivo === false) {
      console.log("[collab] socket sin pong, se termina");
      ws.terminate();
      continue;
    }
    ws.__vivo = false;
    try {
      ws.ping();
    } catch {
      ws.terminate();
    }
  }
}, LATIDO_MS).unref();

server.server?.webSocketServer?.on("connection", (ws) => {
  ws.__vivo = true;
  ws.on("pong", () => {
    ws.__vivo = true;
  });
});
