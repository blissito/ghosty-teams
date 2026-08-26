// Conector de Odoo — el primero de la familia que se conecta con credenciales tecleadas.
//
// Transporte: JSON-RPC (`POST /jsonrpc`), no XML-RPC. Los dos son oficiales y equivalentes,
// pero JSON-RPC es JSON sobre `fetch` y XML-RPC obligaría a meter una dependencia nueva para
// hablar el mismo protocolo con más pasos.
//
// La superficie es GENÉRICA a propósito (search_read / count / fields / name_search / create
// / write / archive). Siete tools cubren los ~1000 modelos de Odoo más los que cada cliente
// se haya inventado; curar por modelo daría veinte tools que cubren el 5% y garantiza que la
// primera pregunta fuera de guion no tenga respuesta. Lo que el modelo pierde con lo
// genérico —no saber qué campos existen— se paga en `ambientContext`, que es gratis, y no
// con un `fields_get` en caliente antes de cada acción, que se ve como lentitud.

import type { ConnectorTool, ConnectorModule, VerifyResult, ToolChannel } from "./impl";
import { notaNombres } from "./impl";
import { getCredentials, notConnected } from "./credentials.server";
import { guardedFetch } from "./net-guard.server";

type OdooFields = { url: string; db: string; login: string };

const NAME = "Odoo";
/** Tope duro de filas por respuesta: todo esto acaba en el contexto del modelo. */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
/** Escrituras masivas: un `write` sobre cientos de ids casi siempre es un error del modelo. */
const MAX_WRITE_IDS = 50;

// ── Transporte ───────────────────────────────────────────────────────────────────

type RpcOk = { result: unknown };
type RpcErr = { error: { message?: string; data?: { name?: string; message?: string; arguments?: unknown[] } } };

/**
 * Quita el secreto de cualquier texto antes de que viaje al modelo o a un log.
 *
 * ⚠️ Sólo a partir de 8 caracteres. Con una key corta —una errata, o un `k` de prueba— el
 * `split/join` hace estropicio: sustituye TODAS las letras `k` del mensaje y lo deja
 * ilegible, que es peor que no redactar. Una API key de verdad es larga; un secreto de 3
 * caracteres no es un secreto que proteger, es un dato mal tecleado.
 */
function redact(text: string, secret: string): string {
  if (!secret || secret.length < 8) return text;
  return text.split(secret).join("«api key»");
}

async function rpc(
  origin: string,
  service: string,
  method: string,
  args: unknown[],
  secret: string
): Promise<unknown> {
  const { status, body } = await guardedFetch(origin, "/jsonrpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: 1, params: { service, method, args } }),
  });

  if (status === 404) {
    throw new OdooError(
      "Esa dirección responde, pero no expone la API JSON-RPC de Odoo. Revisa que sea la URL de la instancia y no la de su sitio web."
    );
  }
  let json: RpcOk | RpcErr;
  try {
    json = JSON.parse(body);
  } catch {
    // Una página web en vez de JSON es el síntoma de una URL que no es la instancia: el
    // sitio comercial, un proxy, un portal de login. Volcarle 300 caracteres de HTML al
    // modelo no le dice nada y le da material para inventar diagnósticos.
    if (/^\s*<(!doctype|html)/i.test(body)) {
      throw new OdooError(
        "Esa dirección devuelve una página web, no la API de Odoo. Suele pasar al poner la URL del sitio en vez de la de la instancia."
      );
    }
    throw new OdooError(`Odoo respondió ${status} con algo que no es JSON: ${clip(redact(body, secret), 200)}`);
  }
  if ("error" in json && json.error) {
    throw translateOdooError(json.error, secret);
  }
  return (json as RpcOk).result;
}

/** Error ya traducido a español accionable. Nunca sale de aquí un "403" pelado. */
class OdooError extends Error {
  /** `true` si conviene reintentar tras re-loguear (sesión perdida, uid caducado). */
  session: boolean;
  constructor(message: string, session = false) {
    super(message);
    this.session = session;
  }
}

/** El detalle de Odoo va al contexto del modelo: útil, pero no un volcado entero. */
function clip(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function translateOdooError(err: RpcErr["error"], secret: string): OdooError {
  const name = err?.data?.name ?? "";
  // El `message` de Odoo es texto para humanos y suele decir EXACTAMENTE qué campo falta.
  // Se devuelve tal cual en vez de tragárselo: es lo que permite que el modelo se corrija
  // solo cuando manda `partner_id:"Acme"` donde va un entero.
  const detail = redact(String(err?.data?.message || err?.message || "").trim(), secret);

  if (name.includes("AccessDenied")) {
    return new OdooError(
      "Odoo rechazó el usuario o la API key. Puede ser también que el nombre de la base de datos esté mal. Hay que corregirlo en Ajustes → Integraciones.",
      false
    );
  }
  if (name.includes("AccessError")) {
    return new OdooError(
      `Ese usuario de Odoo no tiene permiso para esta operación. Pídele a su administrador que le dé acceso al módulo correspondiente. Odoo dijo: ${detail}`
    );
  }
  if (name.includes("SessionExpired")) {
    return new OdooError("La sesión de Odoo caducó.", true);
  }
  if (name.includes("ValidationError") || name.includes("UserError") || name.includes("MissingError")) {
    return new OdooError(`Odoo no aceptó la operación: ${clip(detail)}`);
  }
  // Base de datos inexistente. Odoo NO lo manda como AccessDenied: lo deja salir como el
  // error crudo de su Postgres, que además viene con la IP y el puerto internos de su
  // infraestructura. Ni eso le sirve al modelo ni debe acabar en pantalla; y el nombre de la
  // base es justo el dato que la gente escribe mal al conectar.
  const db = /database "?([^"\s]+)"? does not exist/i.exec(detail);
  if (db) {
    return new OdooError(
      `La base de datos "${db[1]}" no existe en ese Odoo. Corrige su nombre en Ajustes → Integraciones (en Odoo Online suele ser el subdominio).`
    );
  }
  return new OdooError(detail ? `Odoo respondió: ${clip(detail)}` : "Odoo respondió con un error que no trae detalle.");
}

async function login(origin: string, db: string, user: string, secret: string): Promise<number | null> {
  const uid = await rpc(origin, "common", "login", [db, user, secret], secret);
  return typeof uid === "number" && uid > 0 ? uid : null;
}

/** Contexto vivo de una llamada: credenciales + uid resuelto. */
type Session = { origin: string; db: string; login: string; secret: string; uid: number };

const uidCache = new Map<string, { uid: number; at: number }>();
const UID_TTL_MS = 30 * 60_000;

async function session(sub: string): Promise<Session | null> {
  const creds = await getCredentials<OdooFields>(sub, "odoo");
  if (!creds) return null;
  const { db, login: user } = creds.fields;
  if (!db || !user) return null;

  const key = `${sub}:${creds.origin}:${db}:${user}`;
  const hit = uidCache.get(key);
  if (hit && Date.now() - hit.at < UID_TTL_MS) {
    return { origin: creds.origin, db, login: user, secret: creds.secret, uid: hit.uid };
  }
  // El `uid` capturado al conectar evita un login por turno; si no está, se hace uno.
  const cached = Number(creds.probe?.uid);
  const uid = Number.isFinite(cached) && cached > 0 ? cached : await login(creds.origin, db, user, creds.secret);
  if (!uid) return null;
  uidCache.set(key, { uid, at: Date.now() });
  return { origin: creds.origin, db, login: user, secret: creds.secret, uid };
}

/** `execute_kw` con un solo reintento tras re-loguear si la sesión se perdió. */
async function call(
  s: Session,
  model: string,
  method: string,
  args: unknown[],
  kwargs: Record<string, unknown> = {}
): Promise<unknown> {
  try {
    return await rpc(s.origin, "object", "execute_kw", [s.db, s.uid, s.secret, model, method, args, kwargs], s.secret);
  } catch (e) {
    if (!(e instanceof OdooError) || !e.session) throw e;
    const uid = await login(s.origin, s.db, s.login, s.secret);
    if (!uid) throw new OdooError("La API key de Odoo dejó de ser válida. Hay que reconectarla en Ajustes → Integraciones.");
    uidCache.set(`${s.origin}:${s.db}:${s.login}`, { uid, at: Date.now() });
    return await rpc(s.origin, "object", "execute_kw", [s.db, uid, s.secret, model, method, args, kwargs], s.secret);
  }
}

// ── Validación de argumentos ─────────────────────────────────────────────────────

function asModel(v: unknown): string {
  const m = String(v ?? "").trim();
  // Nombres de modelo de Odoo: `crm.lead`, `x_custom.model`. Acotarlo evita que un argumento
  // raro acabe formando parte de la petición.
  if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i.test(m)) throw new OdooError(`"${m}" no parece un modelo de Odoo (por ejemplo: crm.lead).`);
  return m;
}

/** El `domain` de Odoo: lista de condiciones `["campo","op",valor]` y operadores "&", "|", "!". */
function asDomain(v: unknown): unknown[] {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new OdooError('El filtro tiene que ser una lista, por ejemplo [["name","ilike","acme"]].');
  for (const item of v) {
    if (typeof item === "string") {
      if (!["&", "|", "!"].includes(item)) throw new OdooError(`Operador de filtro no válido: "${item}".`);
      continue;
    }
    if (!Array.isArray(item) || item.length !== 3) {
      throw new OdooError('Cada condición del filtro tiene que ser ["campo", "operador", valor].');
    }
  }
  return v;
}

function asIds(v: unknown): number[] {
  const arr = Array.isArray(v) ? v : [v];
  const ids = arr.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) throw new OdooError("Falta el id (o los ids) de los registros.");
  if (ids.length > MAX_WRITE_IDS) {
    throw new OdooError(`Son demasiados registros de una vez (${ids.length}, el tope es ${MAX_WRITE_IDS}). Hazlo por partes.`);
  }
  return ids;
}

function asValues(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new OdooError("Los valores tienen que ser un objeto {campo: valor}.");
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k.startsWith("__")) continue;
    out[k] = val;
  }
  if (!Object.keys(out).length) throw new OdooError("No hay ningún valor que escribir.");
  return out;
}

function asLimit(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/** Bitácora de escritura. En un ERP ajeno, "quién escribió qué" no puede depender del log de Odoo. */
function auditWrite(sub: string, action: string, model: string, ids: number[] | null, values: Record<string, unknown>) {
  console.info(
    `[odoo] ${action} sub=${sub} model=${model}` +
      (ids ? ` ids=${ids.join(",")}` : "") +
      ` campos=${Object.keys(values).join(",")}` // las CLAVES, nunca los valores
  );
}

/** Envuelve un handler: traduce cualquier fallo a `{error}` — un handler NUNCA lanza. */
function guard<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  return fn().catch((e) => ({
    error: e instanceof OdooError ? e.message : `No pude hablar con ${NAME}: ${e instanceof Error ? e.message : String(e)}`,
  }));
}

// ── El ping de conexión ──────────────────────────────────────────────────────────

export async function verifyCredentials(fields: Record<string, string>): Promise<VerifyResult> {
  const { url, db, login: user, apiKey } = fields;
  try {
    const uid = await login(url, db, user, apiKey);
    if (!uid) {
      return {
        ok: false,
        error:
          "Odoo rechazó esos datos. Revisa el usuario, la API key y sobre todo el nombre de la base de datos, que es donde más se falla.",
      };
    }
    // Se captura la versión para el contexto, sin que un fallo aquí tumbe la conexión.
    let version: string | null = null;
    try {
      const info = (await rpc(url, "common", "version", [], apiKey)) as { server_version?: string };
      version = info?.server_version ?? null;
    } catch {
      /* opcional */
    }
    return { ok: true, externalId: String(uid), probe: { uid, version } };
  } catch (e) {
    return { ok: false, error: e instanceof OdooError ? e.message : `No pude contactar a Odoo: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ── Tools ────────────────────────────────────────────────────────────────────────
// Lista CONSTANTE: así es imposible que el listado varíe por `dest.parentId` (lo prohíbe
// no-regresion.test.ts) y el orden queda estable (lo fija scope-listado.test.ts).

const MODEL_PROP = { model: { type: "string", description: "Modelo de Odoo, p. ej. crm.lead, res.partner, sale.order" } };

export const tools: ConnectorTool[] = [
  {
    name: "odoo_search_read",
    description:
      "Busca y lee registros de cualquier modelo de Odoo. El filtro va en formato domain de Odoo. Si no sabes qué campos tiene el modelo, usa odoo_fields antes.",
    inputSchema: {
      type: "object",
      properties: {
        ...MODEL_PROP,
        domain: { type: "array", description: 'Filtro, p. ej. [["stage_id","!=",false],["expected_revenue",">",1000]]. Vacío = todos.' },
        fields: { type: "array", items: { type: "string" }, description: "Campos a traer. Omitir trae los básicos." },
        limit: { type: "number", description: `Máximo de filas (tope ${MAX_LIMIT}, por defecto ${DEFAULT_LIMIT}).` },
        offset: { type: "number" },
        order: { type: "string", description: 'Orden, p. ej. "create_date desc".' },
      },
      required: ["model"],
      additionalProperties: false,
    },
    handler: (sub, args) =>
      guard(async () => {
        const s = await session(sub);
        if (!s) return notConnected(NAME);
        const kwargs: Record<string, unknown> = { limit: asLimit(args.limit) };
        if (Array.isArray(args.fields) && args.fields.length) kwargs.fields = args.fields.map(String);
        if (Number(args.offset) > 0) kwargs.offset = Math.floor(Number(args.offset));
        if (typeof args.order === "string" && args.order.trim()) kwargs.order = args.order.trim();
        const rows = await call(s, asModel(args.model), "search_read", [asDomain(args.domain)], kwargs);
        return { rows, count: Array.isArray(rows) ? rows.length : 0 };
      }),
  },
  {
    name: "odoo_count",
    description: "Cuenta cuántos registros cumplen un filtro, sin traerlos. Úsalo cuando sólo necesites el número.",
    inputSchema: {
      type: "object",
      properties: { ...MODEL_PROP, domain: { type: "array" } },
      required: ["model"],
      additionalProperties: false,
    },
    handler: (sub, args) =>
      guard(async () => {
        const s = await session(sub);
        if (!s) return notConnected(NAME);
        return { count: await call(s, asModel(args.model), "search_count", [asDomain(args.domain)]) };
      }),
  },
  {
    name: "odoo_fields",
    description:
      "Lista los campos de un modelo con su tipo, si es obligatorio y a qué modelo apunta si es una relación. Consúltalo antes de crear o actualizar si no estás seguro de los nombres.",
    inputSchema: {
      type: "object",
      properties: { ...MODEL_PROP, filter: { type: "string", description: "Si lo pasas, sólo devuelve campos cuyo nombre o etiqueta lo contengan." } },
      required: ["model"],
      additionalProperties: false,
    },
    handler: (sub, args) =>
      guard(async () => {
        const s = await session(sub);
        if (!s) return notConnected(NAME);
        const raw = (await call(s, asModel(args.model), "fields_get", [], {
          attributes: ["string", "type", "required", "relation", "selection"],
        })) as Record<string, any>;
        const needle = String(args.filter ?? "").toLowerCase();
        const out: Record<string, unknown> = {};
        for (const [key, f] of Object.entries(raw ?? {})) {
          if (needle && !key.toLowerCase().includes(needle) && !String(f?.string ?? "").toLowerCase().includes(needle)) continue;
          out[key] = { label: f?.string, type: f?.type, required: f?.required || undefined, relation: f?.relation || undefined, selection: f?.selection || undefined };
        }
        return { fields: out };
      }),
  },
  {
    name: "odoo_name_search",
    description:
      "Busca registros por nombre y devuelve [id, nombre]. Es la forma de obtener el id que piden los campos de relación (partner_id, user_id, product_id…) antes de crear o actualizar.",
    inputSchema: {
      type: "object",
      properties: { ...MODEL_PROP, name: { type: "string", description: "Texto a buscar." }, limit: { type: "number" } },
      required: ["model", "name"],
      additionalProperties: false,
    },
    handler: (sub, args) =>
      guard(async () => {
        const s = await session(sub);
        if (!s) return notConnected(NAME);
        const matches = await call(s, asModel(args.model), "name_search", [], {
          name: String(args.name ?? ""),
          limit: Math.min(asLimit(args.limit), 20),
        });
        return { matches };
      }),
  },
  {
    name: "odoo_create",
    description:
      "Crea un registro. Los campos de relación van por id numérico (usa odoo_name_search para obtenerlo), no por nombre. Devuelve el id creado.",
    inputSchema: {
      type: "object",
      properties: { ...MODEL_PROP, values: { type: "object", description: "{campo: valor} del registro nuevo." } },
      required: ["model", "values"],
      additionalProperties: false,
    },
    handler: (sub, args) =>
      guard(async () => {
        const s = await session(sub);
        if (!s) return notConnected(NAME);
        const model = asModel(args.model);
        const values = asValues(args.values);
        auditWrite(sub, "create", model, null, values);
        const id = await call(s, model, "create", [values]);
        return { id, model, creadoPor: s.login };
      }),
  },
  {
    name: "odoo_write",
    description:
      "Actualiza uno o varios registros existentes. Los campos de relación van por id numérico. No sirve para borrar: para quitar algo de circulación usa odoo_archive.",
    inputSchema: {
      type: "object",
      properties: {
        ...MODEL_PROP,
        ids: { type: "array", items: { type: "number" }, description: `Ids a actualizar (máximo ${MAX_WRITE_IDS}).` },
        values: { type: "object" },
      },
      required: ["model", "ids", "values"],
      additionalProperties: false,
    },
    handler: (sub, args) =>
      guard(async () => {
        const s = await session(sub);
        if (!s) return notConnected(NAME);
        const model = asModel(args.model);
        const ids = asIds(args.ids);
        const values = asValues(args.values);
        auditWrite(sub, "write", model, ids, values);
        await call(s, model, "write", [ids, values]);
        return { ok: true, model, ids, actualizadoPor: s.login };
      }),
  },
  {
    name: "odoo_archive",
    description:
      "Archiva registros (los marca como inactivos). Es lo que hay que usar cuando alguien pide borrar algo: en Odoo archivar se puede deshacer y borrar no. Pasa restore:true para devolverlos.",
    inputSchema: {
      type: "object",
      properties: {
        ...MODEL_PROP,
        ids: { type: "array", items: { type: "number" } },
        restore: { type: "boolean", description: "true = desarchivar." },
      },
      required: ["model", "ids"],
      additionalProperties: false,
    },
    handler: (sub, args) =>
      guard(async () => {
        const s = await session(sub);
        if (!s) return notConnected(NAME);
        const model = asModel(args.model);
        const ids = asIds(args.ids);
        const active = args.restore === true;
        auditWrite(sub, active ? "restore" : "archive", model, ids, { active });
        await call(s, model, "write", [ids, { active }]);
        return { ok: true, model, ids, archivados: !active };
      }),
  },
];

// ── Contexto ambiente ────────────────────────────────────────────────────────────
// Sin red: todo sale de la fila. Lo que el modelo necesita para acertar a la primera con
// tools genéricas — y lo que se equivoca solo si no se le dice.

const CHEATSHEET = `Modelos más usados y sus campos útiles:
- crm.lead (oportunidades): name, partner_id, email_from, phone, expected_revenue, probability, stage_id, user_id, description, create_date
- res.partner (clientes y proveedores): name, email, phone, is_company, parent_id, street, city, vat
- sale.order (cotizaciones y pedidos): name, partner_id, state, amount_total, date_order, order_line
- sale.order.line: order_id, product_id, product_uom_qty, price_unit
- product.template / product.product: name, default_code, list_price, qty_available, type
- stock.quant (existencias): product_id, location_id, quantity, available_quantity`;

const CONVENTIONS = `Reglas de la API de Odoo que conviene no olvidar:
- Un campo de relación (los que acaban en _id) se LEE como [id, "nombre"] y se ESCRIBE como el id numérico solo. Para obtener el id usa odoo_name_search.
- Las fechas van en UTC con formato "YYYY-MM-DD HH:MM:SS".
- El filtro (domain) es una lista de condiciones ["campo","operador",valor]; los operadores "&", "|" y "!" van ANTES de las condiciones que combinan.
- No puedes borrar registros. Si te piden borrar algo, usa odoo_archive y dilo con esas palabras: queda archivado y se puede recuperar.`;

export async function ambientContext(
  sub: string,
  _sender: string,
  _message: string,
  _dest: unknown,
  opts?: { toolChannel?: ToolChannel }
): Promise<string | null> {
  const creds = await getCredentials<OdooFields>(sub, "odoo");
  if (!creds) return null;
  const host = (() => {
    try {
      return new URL(creds.origin).host;
    } catch {
      return creds.origin;
    }
  })();
  const version = creds.probe?.version ? ` (versión ${creds.probe.version})` : "";
  return (
    `Hay un Odoo conectado: ${host}${version}, base de datos "${creds.fields.db}". ` +
    // Con conexión compartida el agente actúa con la cuenta de otra persona, y tiene que
    // poder decirlo: en el chatter de Odoo los cambios quedan firmados con ese nombre.
    `Todo lo que consultes o escribas ocurre con el usuario ${creds.fields.login}, así que los cambios quedarán registrados a su nombre en Odoo. ` +
    `Puedes trabajar con cualquier modelo de Odoo mediante odoo_search_read, odoo_count, odoo_fields, odoo_name_search, odoo_create, odoo_write y odoo_archive. ` +
    notaNombres(opts?.toolChannel) +
    `\n\n${CHEATSHEET}\n\n${CONVENTIONS}`
  );
}

const _module: ConnectorModule = { tools, ambientContext, verifyCredentials };
export default _module;

export type { OdooFields };
