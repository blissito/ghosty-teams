// Cliente HTTP al sqld (libsql-server) self-hosted en el bare metal de OVH.
// Multitenant: el NAMESPACE que sirve este request se resuelve por subdominio
// (ver server/tenant.server.ts). Un solo sqld sirve todos los tenants; el
// aislamiento es por namespace (uno por workspace), el token de auth es compartido.
// EasyBits YA no está en el camino de datos de Teams (queda solo para la flota).
//
// API pipeline de sqld: POST /v2/pipeline con header x-namespace; body
// { requests: [{type:"execute", stmt:{sql,args}}, {type:"close"}] }.
import { currentNamespace } from "./server/tenant.server";

const SQLD_URL = process.env.SQLD_URL ?? "http://127.0.0.1:8080";
const SQLD_AUTH = process.env.SQLD_AUTH_TOKEN ?? "";

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
export async function dbqRaw(
  sql: string,
  args: unknown[] = []
): Promise<{ cols: string[]; rows: (string | null)[][] }> {
  const namespace = await currentNamespace();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-namespace": namespace,
  };
  if (SQLD_AUTH) headers.Authorization = `Bearer ${SQLD_AUTH}`;
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
  return { cols, rows };
}

// Forma de objetos { [col]: value } — la usada por db.server.ts.
export async function dbq(sql: string, args: unknown[] = []): Promise<Row[]> {
  const { cols, rows } = await dbqRaw(sql, args);
  return rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
}

export const num = (v: string | null | undefined) => Number(v ?? 0);
