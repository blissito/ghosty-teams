// Cliente HTTP al sqld (libsql-server) self-hosted en el bare metal de OVH.
// Multitenant: el NAMESPACE que sirve este request se resuelve por subdominio
// (ver server/tenant.server.ts). Un solo sqld sirve todos los tenants; el
// aislamiento es por namespace (uno por workspace).
//
// EL TOKEN YA NO ES COMPARTIDO, y el cambio importa: en sqld el claim `id` es lo
// único que acota un token a un namespace, y un token SIN ese claim entrega la
// instancia ENTERA (probado, ver docs/sqld-auth.md de sandbox-host). Un token
// compartido entre todos los workspaces era, por definición, un token sin acotar:
// cualquier fuga —de un log, de una variable de entorno, de esta caja— habría
// entregado los datos de todos los tenants a la vez. Ahora se firma uno por
// petición, acotado al namespace que esa petición va a tocar y con minutos de
// vida.
// EasyBits YA no está en el camino de datos de Teams (queda solo para la flota).
//
// API pipeline de sqld: POST /v2/pipeline con header x-namespace; body
// { requests: [{type:"execute", stmt:{sql,args}}, {type:"close"}] }.
import { currentNamespace } from "./server/tenant.server";

import { createPrivateKey, sign as cryptoSign } from "node:crypto";

const SQLD_URL = process.env.SQLD_URL ?? "http://127.0.0.1:8080";
/** Clave privada Ed25519 (base64) con la que se firman los tokens por namespace. */
const SQLD_JWT_PRIVATE_KEY = process.env.SQLD_JWT_PRIVATE_KEY ?? "";

/**
 * Firma un JWT acotado a UN namespace.
 *
 * El `id` se construye aquí y nunca se acepta de fuera: sin él, sqld entrega
 * todos los namespaces de la instancia.
 */
export function tokenPara(namespace: string): string {
  if (!SQLD_JWT_PRIVATE_KEY) return "";
  if (!namespace) throw new Error("sqld: token sin namespace sería un token maestro");
  const raw = Buffer.from(SQLD_JWT_PRIVATE_KEY, "base64");
  const pkcs8 = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    raw.subarray(0, 32),
  ]);
  const key = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
  const header = b64url(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ id: namespace, a: "rw", exp: Math.floor(Date.now() / 1000) + 600 }),
  );
  const firmado = `${header}.${payload}`;
  return `${firmado}.${b64url(cryptoSign(null, Buffer.from(firmado), key))}`;
}

export type Row = Record<string, string | null>;

type SqldArg = { type: "integer" | "float" | "text" | "null"; value?: string };
function toArg(v: unknown): SqldArg {
  if (v === null || v === undefined) return { type: "null" };
  if (typeof v === "number") {
    return Number.isInteger(v)
      ? { type: "integer", value: String(v) }
      : { type: "float", value: String(v) };
  }
  return { type: "text", value: typeof v === "string" ? v : String(v) };
}

interface PipelineResponse {
  results: Array<{
    type: "ok" | "error";
    response?: {
      result: {
        cols: Array<{ name: string }>;
        rows: Array<Array<{ value?: unknown }>>;
      };
    };
    error?: { message: string };
  }>;
}

// Forma cruda { cols, rows } — como devolvía el endpoint viejo de EasyBits. Todos
// los valores se stringifican (contrato histórico: las tablas gc_* se leen como
// string|null y se coercionan con num()). Usado por los callers que indexan por
// posición (users/config/invites).
// Traza de queries LENTAS (>SLOW_MS) al journal del proceso: sin esto, diagnosticar
// "la carga tarda minutos" es adivinar. Se activa siempre; el ruido es mínimo.
const SLOW_MS = Number(process.env.DB_SLOW_MS ?? 200);
function slow(sql: string, ms: number, rows: number) {
  if (ms < SLOW_MS) return;
  console.log(`[db ${Math.round(ms)}ms rows=${rows}] ${sql.replace(/\s+/g, " ").slice(0, 140)}`);
}

export async function dbqRaw(
  sql: string,
  args: unknown[] = []
): Promise<{ cols: string[]; rows: (string | null)[][] }> {
  const t0 = performance.now();
  const namespace = await currentNamespace();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-namespace": namespace,
  };
  const token = tokenPara(namespace);
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${SQLD_URL}/v2/pipeline`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      requests: [
        { type: "execute", stmt: { sql, args: args.map(toArg) } },
        { type: "close" },
      ],
    }),
  });
  if (!res.ok) throw new Error(`db ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as PipelineResponse;
  const first = data.results[0];
  if (!first || first.type === "error") {
    throw new Error(`db: ${first?.error?.message ?? "sqld error"}`);
  }
  const r = first.response!.result;
  const cols = r.cols.map((c) => c.name);
  const rows = r.rows.map((row) =>
    row.map((cell) => (cell?.value == null ? null : String(cell.value)))
  );
  slow(sql, performance.now() - t0, rows.length);
  return { cols, rows };
}

// Forma de objetos { [col]: value } — la usada por db.server.ts.
export async function dbq(sql: string, args: unknown[] = []): Promise<Row[]> {
  const { cols, rows } = await dbqRaw(sql, args);
  return rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
}

// N queries en UN SOLO round-trip al sqld. El protocolo pipeline ya acepta varios
// `execute` en el mismo body: cada `dbq()` suelto paga su propia latencia HTTP, y en
// el arranque de un room eso se multiplica (attachMeta = 5 viajes seriados sobre TODO
// el historial). Mismo contrato de valores que dbq (strings|null).
export async function dbqMany(
  stmts: { sql: string; args?: unknown[] }[]
): Promise<Row[][]> {
  if (!stmts.length) return [];
  const t0 = performance.now();
  const namespace = await currentNamespace();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-namespace": namespace,
  };
  const token = tokenPara(namespace);
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${SQLD_URL}/v2/pipeline`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      requests: [
        ...stmts.map((s) => ({
          type: "execute",
          stmt: { sql: s.sql, args: (s.args ?? []).map(toArg) },
        })),
        { type: "close" },
      ],
    }),
  });
  if (!res.ok) throw new Error(`db ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as PipelineResponse;
  slow(`[many x${stmts.length}] ${stmts[0].sql}`, performance.now() - t0, 0);
  return stmts.map((_, i) => {
    const r = data.results[i];
    if (!r || r.type === "error") throw new Error(`db: ${r?.error?.message ?? "sqld error"}`);
    const result = r.response!.result;
    const cols = result.cols.map((c) => c.name);
    return result.rows.map((row) =>
      Object.fromEntries(cols.map((c, ci) => [c, row[ci]?.value == null ? null : String(row[ci]!.value)]))
    ) as Row[];
  });
}

// Como dbqMany pero SIN abortar: devuelve el resultado o el error de CADA sentencia.
// Lo usan las migraciones, que toleran fallos por-sentencia y los acumulan.
export async function dbqManySettled(
  stmts: { sql: string; args?: unknown[] }[]
): Promise<{ ok: boolean; rows: Row[]; error?: string }[]> {
  if (!stmts.length) return [];
  const namespace = await currentNamespace();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-namespace": namespace,
  };
  const token = tokenPara(namespace);
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${SQLD_URL}/v2/pipeline`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      requests: [
        ...stmts.map((s) => ({
          type: "execute",
          stmt: { sql: s.sql, args: (s.args ?? []).map(toArg) },
        })),
        { type: "close" },
      ],
    }),
  });
  if (!res.ok) throw new Error(`db ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as PipelineResponse;
  return stmts.map((_, i) => {
    const r = data.results[i];
    if (!r || r.type === "error") return { ok: false, rows: [], error: r?.error?.message ?? "sqld error" };
    const result = r.response!.result;
    const cols = result.cols.map((c) => c.name);
    const rows = result.rows.map((row) =>
      Object.fromEntries(cols.map((c, ci) => [c, row[ci]?.value == null ? null : String(row[ci]!.value)]))
    ) as Row[];
    return { ok: true, rows };
  });
}

export const num = (v: string | null | undefined) => Number(v ?? 0);
