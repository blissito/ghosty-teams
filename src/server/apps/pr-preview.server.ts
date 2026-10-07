// «Levantar preview» a pedido para un PR SIN pedido de la fábrica (dependabot, personas).
//
// Decisión de bliss (7-oct): el PR de un pedido tiene su preview automática dentro de la caja
// del pedido; los demás NO la tienen sola, pero su tarjeta ofrece el botón. Construye en una
// caja aparte con el flujo de gs `internal/workspace-preview` (`up` → `status`), liga privada
// con llave, duerme sin tráfico y se tira al mezclar o cerrar (`down` en api.internal.github-event).

export type PrPreviewInput = { channelId: number; repo: string; number: number };
export type PrPreviewView =
  | { eligible: false; reason: "run" | "repo" | "off" }
  | {
      eligible: true;
      phase: "none" | "creating" | "fetching" | "installing" | "building" | "starting" | "ready" | "failed";
      url: string | null;
      error: string | null;
      sha: string | null;
    };

type Me = { sub: string; isOwner: boolean };

function clean(input: PrPreviewInput): PrPreviewInput {
  const repo = String(input.repo ?? "").trim();
  const number = Number(input.number);
  const channelId = Number(input.channelId);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("repo inválido");
  if (!Number.isInteger(number) || number <= 0) throw new Error("PR inválido");
  if (!Number.isInteger(channelId) || channelId <= 0) throw new Error("room inválido");
  return { repo, number, channelId };
}

/** Las compuertas: ves el room, el repo es del room, el PR no es de un pedido, la preview no está apagada. */
async function gate(me: Me, input: PrPreviewInput): Promise<{ ok: true; repo: string; number: number } | { ok: false; reason: "run" | "repo" | "off" }> {
  const { repo, number, channelId } = clean(input);
  const db = await import("../../db.server");
  if (!(await db.listChannels(me.sub, me.isOwner)).some((c) => c.id === channelId)) throw new Error("no ves ese room");
  if (!(await db.listRoomRepos(channelId)).some((r) => r.repo.toLowerCase() === repo.toLowerCase())) return { ok: false, reason: "repo" };
  const R = await import("./factory-runs.server");
  // El PR de un pedido ya tiene su preview automática en la caja del pedido.
  if ((await R.runsByPr(repo, number)).length) return { ok: false, reason: "run" };
  if (await R.repoPreviewOff(repo)) return { ok: false, reason: "off" };
  return { ok: true, repo, number };
}

function view(b: any): PrPreviewView {
  if (!b || !b.phase) return { eligible: true, phase: "none", url: null, error: null, sha: null };
  return {
    eligible: true,
    phase: b.phase,
    url: b.phase === "ready" ? (b.url ?? null) : null,
    error: b.phase === "failed" ? String(b.error ?? "la preview no arrancó").split("\n")[0].slice(0, 200) : null,
    sha: b.sha ?? null,
  };
}

/** Lo que hay ahora (sin levantar nada). */
export async function prPreviewStatus(me: Me, input: PrPreviewInput): Promise<PrPreviewView> {
  const g = await gate(me, input);
  if (!g.ok) return { eligible: false, reason: g.reason };
  const P = await import("./preview.server");
  const out = await P.gsPreview("status", { repo: g.repo, pr: g.number });
  return view(out?.status);
}

/** Levanta (o reconstruye con la cabeza actual) la preview del PR en su caja aparte. */
export async function prPreviewUp(me: Me, input: PrPreviewInput): Promise<PrPreviewView> {
  const g = await gate(me, input);
  if (!g.ok) {
    throw new Error(
      g.reason === "run"
        ? "este PR es de un pedido: su preview se levanta sola"
        : g.reason === "off"
          ? "el dueño apagó la preview de este repo"
          : "el repo no está ligado a este room",
    );
  }
  const R = await import("./factory-runs.server");
  const head = await R.prHead(me.sub, `https://github.com/${g.repo}/pull/${g.number}`);
  if (!head) throw new Error("no pude leer el PR en GitHub (¿tu GitHub está conectado?)");
  const P = await import("./preview.server");
  return view(await P.gsPreview("up", { repo: g.repo, pr: g.number, sha: head.sha }));
}
