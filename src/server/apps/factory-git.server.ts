// ── Push de verdad desde la caja: proxy git con la credencial inyectada ─────────────────────
//
// @build trabaja en una caja de trabajo con un clon real. Antes subía sus cambios con
// `github_push_files`, o sea, los BYTES de cada archivo viajaban por su script como JSON: un
// bundle de 11 MB llegó cortado a GitHub (el `exec` de la caja corta a 1 MB) y el pedido #17
// de MailMask se atoró (7-oct). Lo que hace la industria (Copilot cloud agent, Jules, Devin y
// los kits git de Docker sbx) es empujar el árbol de trabajo con git, con una credencial que
// NUNCA entra a la caja.
//
// Aquí: la caja recibe un remote `https://x-access-token:gfp_…@<tenant>/api/git/<run>/<o>/<r>.git`.
// `gfp_` es un token de SESIÓN (atado a un pedido y un repo, caduca en 2 h, se guarda sólo su
// hash). Este proxy lo cambia por el token de escritura del bot (`gitWriteToken`, que vuelve a
// imponer el permiso de quien pidió) y reenvía Smart HTTP a github.com sin cargar el body en
// memoria. Antes de un push lee los comandos de `receive-pack` y sólo deja actualizar UNA rama
// que no sea la principal; la primera rama que empuja la sesión queda fija (como `copilot/*`).
import { dbq } from "../../dbq.server";

const TTL_S = 2 * 60 * 60;
const ZERO = "0".repeat(40);

export type RefUpdate = { old: string; new: string; ref: string };

/** Los comandos del principio de un body de `git-receive-pack`. `null` si no se completaron. */
export function parseReceivePackCommands(buf: Uint8Array): { cmds: RefUpdate[]; caps: string[]; end: number } | null {
  const cmds: RefUpdate[] = [];
  let caps: string[] = [];
  let i = 0;
  const dec = new TextDecoder();
  while (i + 4 <= buf.length) {
    const len = parseInt(dec.decode(buf.subarray(i, i + 4)), 16);
    if (Number.isNaN(len)) throw new Error("pkt-line inválida");
    if (len === 0) return { cmds, caps, end: i + 4 }; // flush: terminaron los comandos
    if (len < 4) throw new Error("pkt-line inválida");
    if (i + len > buf.length) return null;
    const [raw, capStr] = dec.decode(buf.subarray(i + 4, i + len)).split("\0");
    const [oldSha, newSha, ref] = raw.replace(/\n$/, "").split(" ");
    // `shallow <sha>` puede venir antes de los comandos; no actualiza nada.
    if (oldSha !== "shallow") {
      if (!/^[0-9a-f]{40}$/.test(oldSha ?? "") || !/^[0-9a-f]{40}$/.test(newSha ?? "") || !ref) throw new Error("comando de push inválido");
      if (capStr !== undefined && !cmds.length) caps = capStr.trim().split(" ");
      cmds.push({ old: oldSha, new: newSha, ref });
    }
    i += len;
  }
  return null;
}

/**
 * ¿Se permite este push? Una sola rama, nunca la principal, sin borrar ni tags; con una rama ya
 * fija (la del pedido, o la primera que empujó la sesión) sólo ésa. Devuelve el porqué o `null`.
 */
export function refUpdateDenial(cmds: RefUpdate[], o: { defaultBranch: string; lockedBranch: string | null }): string | null {
  if (cmds.length !== 1) return "un push del pedido actualiza exactamente una rama";
  const c = cmds[0];
  if (!c.ref.startsWith("refs/heads/")) return `solo ramas: ${c.ref} no se puede empujar`;
  const branch = c.ref.slice("refs/heads/".length);
  if (c.new === ZERO) return `no se borran ramas desde la caja (${branch})`;
  if (branch === o.defaultBranch) return `la rama principal (${branch}) no se toca: trabaja en la rama del pedido`;
  if (o.lockedBranch && branch !== o.lockedBranch) return `este pedido empuja a ${o.lockedBranch}, no a ${branch}`;
  return null;
}

const pktLine = (s: string) => (new TextEncoder().encode(s).length + 4).toString(16).padStart(4, "0") + s;

/**
 * Rechazo dentro del protocolo de git (`ng <ref> <razón>` y `remote: …`): git le enseña la razón
 * a quien empuja, en vez de un «HTTP 403» mudo.
 */
export function receivePackRejection(ref: string, why: string, caps: string[]): Uint8Array<ArrayBuffer> {
  const status = pktLine("unpack ok\n") + pktLine(`ng ${ref} ${why}\n`) + "0000";
  if (!caps.includes("side-band-64k") && !caps.includes("side-band")) return new TextEncoder().encode(status);
  return new TextEncoder().encode(pktLine(`\x02${why}\n`) + pktLine(`\x01${status}`) + "0000");
}

async function sha256(s: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(s).digest("hex");
}

/** Token de sesión para que la caja de un pedido empuje a su repo. Se devuelve UNA vez. */
export async function mintGitSession(o: { runId: number; repo: string; sub: string; branch: string | null }): Promise<string> {
  const { randomBytes } = await import("node:crypto");
  const token = `gfp_${randomBytes(24).toString("base64url")}`;
  await dbq("DELETE FROM gt_factory_git_sessions WHERE expires_at < unixepoch()", []).catch(() => {});
  await dbq(
    "INSERT INTO gt_factory_git_sessions (token_hash, run_id, repo, sub, branch, expires_at) VALUES (?, ?, ?, ?, ?, unixepoch() + ?)",
    [await sha256(token), o.runId, o.repo.toLowerCase(), o.sub, o.branch, TTL_S],
  );
  return token;
}

type Session = { tokenHash: string; runId: number; repo: string; sub: string; branch: string | null };

async function sessionOf(token: string): Promise<Session | null> {
  if (!token.startsWith("gfp_")) return null;
  const h = await sha256(token);
  const [r] = await dbq("SELECT run_id, repo, sub, branch FROM gt_factory_git_sessions WHERE token_hash = ? AND expires_at > unixepoch()", [h]).catch(() => []);
  return r ? { tokenHash: h, runId: Number(r.run_id), repo: String(r.repo), sub: String(r.sub), branch: r.branch ? String(r.branch) : null } : null;
}

// Sin credencial, git reintenta con la del remote: el 401 con `WWW-Authenticate` es lo que se la pide.
const unauthorized = () =>
  new Response("credencial de la sesión inválida o caducada: pide otra con factory_git_remote\n", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="ghosty-factory"' },
  });
const denied = (why: string) => new Response(`${why}\n`, { status: 403, headers: { "Content-Type": "text/plain" } });

/** Lee del stream hasta tener los comandos completos; devuelve lo leído y el resto sin tocar. */
async function readCommands(
  body: ReadableStream<Uint8Array>,
): Promise<{ cmds: RefUpdate[]; caps: string[]; head: Uint8Array; rest: ReadableStreamDefaultReader<Uint8Array> }> {
  const reader = body.getReader();
  let head = new Uint8Array(0);
  for (;;) {
    const parsed = parseReceivePackCommands(head);
    if (parsed) return { cmds: parsed.cmds, caps: parsed.caps, head, rest: reader };
    if (head.length > 256 * 1024) throw new Error("los comandos del push no terminan");
    const { value, done } = await reader.read();
    if (done) throw new Error("push incompleto");
    const next = new Uint8Array(head.length + value.length);
    next.set(head);
    next.set(value, head.length);
    head = next;
  }
}

/** Lo ya leído + lo que falta, como un solo stream para reenviarlo. */
function rejoin(head: Uint8Array, rest: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
  let first = true;
  return new ReadableStream({
    async pull(ctrl) {
      if (first) {
        first = false;
        if (head.length) return ctrl.enqueue(head);
      }
      const { value, done } = await rest.read();
      if (done) ctrl.close();
      else ctrl.enqueue(value);
    },
    cancel(reason) {
      return rest.cancel(reason);
    },
  });
}

const defaultBranchCache = new Map<string, { at: number; v: string }>();
async function defaultBranchOf(sub: string, repo: string): Promise<string | null> {
  const hit = defaultBranchCache.get(repo);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.v;
  const { githubApi } = await import("../connectors/github.server");
  const r = await githubApi(sub, `/repos/${repo}`).catch(() => null);
  const v = typeof r?.default_branch === "string" ? r.default_branch : null;
  if (v) defaultBranchCache.set(repo, { at: Date.now(), v });
  return v;
}

/**
 * El proxy: `info/refs`, `git-upload-pack` y `git-receive-pack` de `/api/git/<run>/<o>/<r>.git`.
 * `path` es lo que sigue a `<run>/` en la URL.
 */
export async function proxyGit(request: Request, runIdParam: string, path: string): Promise<Response> {
  const m = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (!m) return new Response("not found", { status: 404 });
  const [, owner, name, op] = m;
  const repo = `${owner}/${name}`.toLowerCase();
  const url = new URL(request.url);
  const service = op === "info/refs" ? url.searchParams.get("service") : op;
  if (service !== "git-upload-pack" && service !== "git-receive-pack") return denied("servicio git no soportado");

  const auth = request.headers.get("authorization") ?? "";
  const basic = auth.startsWith("Basic ") ? Buffer.from(auth.slice(6), "base64").toString("utf8") : "";
  const session = await sessionOf(basic.slice(basic.indexOf(":") + 1));
  if (!session || String(session.runId) !== runIdParam || session.repo !== repo) return unauthorized();

  const R = await import("./factory-runs.server");
  const run = await R.getRun(session.runId);
  // Pedido cerrado = la sesión se acaba aunque no haya caducado.
  if (!run || run.status === "done" || run.status === "cancelled") return denied(`el pedido #${session.runId} ya está cerrado`);

  const { gitWriteToken } = await import("../connectors/github.server");
  const w = await gitWriteToken(session.sub, repo);
  if ("error" in w) return denied(w.error);

  let body: ReadableStream<Uint8Array> | null = request.method === "POST" ? request.body : null;
  if (op === "git-receive-pack" && body) {
    let read: Awaited<ReturnType<typeof readCommands>>;
    try {
      read = await readCommands(body);
    } catch (e) {
      return denied(e instanceof Error ? e.message : String(e));
    }
    // Sin comandos = la sonda que git manda antes de un push grande (body «0000»): no actualiza nada.
    if (read.cmds.length) {
      const defaultBranch = await defaultBranchOf(session.sub, repo);
      if (!defaultBranch) return denied("no pude leer la rama principal del repo; intenta de nuevo");
      const why = refUpdateDenial(read.cmds, { defaultBranch, lockedBranch: run.branch ?? session.branch });
      if (why) {
        void R.logEvent(run.id, "git_push_denied", "build", { ref: read.cmds[0]?.ref ?? null, why });
        // Se termina de leer el pack: cortar a media subida le da a git un «hung up» sin razón.
        while (!(await read.rest.read()).done);
        return new Response(receivePackRejection(read.cmds[0].ref, why, read.caps), {
          headers: { "Content-Type": "application/x-git-receive-pack-result", "Cache-Control": "no-cache" },
        });
      }
      const branch = read.cmds[0].ref.slice("refs/heads/".length);
      if (!session.branch) await dbq("UPDATE gt_factory_git_sessions SET branch = ? WHERE token_hash = ?", [branch, session.tokenHash]).catch(() => {});
      void R.logEvent(run.id, "git_push", "build", { branch, from: read.cmds[0].old.slice(0, 7), to: read.cmds[0].new.slice(0, 7) });
    }
    body = rejoin(read.head, read.rest);
  }

  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`x-access-token:${w.token}`).toString("base64")}`,
    "User-Agent": request.headers.get("user-agent") ?? "git/ghosty-factory",
  };
  for (const h of ["content-type", "accept", "git-protocol", "content-encoding"]) {
    const v = request.headers.get(h);
    if (v) headers[h] = v;
  }
  const up = await fetch(`https://github.com/${repo}.git/${op}${url.search}`, {
    method: request.method,
    headers,
    ...(body ? { body, duplex: "half" } : {}),
  } as RequestInit);
  const out = new Headers({ "Cache-Control": "no-cache" });
  for (const h of ["content-type", "content-encoding"]) {
    const v = up.headers.get(h);
    if (v) out.set(h, v);
  }
  // El 401 de GitHub (token del bot caducado o sin permiso) no debe pedirle credenciales a la caja.
  return new Response(up.body, { status: up.status === 401 ? 403 : up.status, headers: out });
}
