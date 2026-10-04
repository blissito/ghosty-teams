// La FOTO de la fábrica: qué sabe un rol de un pedido y del room sin tener que buscarlo.
//
// Una sola fuente para dos usos: la foto compacta que va en cada turno (`factoryContext`) y el
// detalle de `factory_context`. El estado vive en la DB (pedido, plan por versión, notas,
// bitácora, sprint); la conversación del rol ya no es la memoria (MailMask, 4-oct: la sesión del
// room llegó a ~200k y compactaba un minuto por una línea). Lecturas puras: NO consume notas
// (`takeNotes` sí, al encargar).
import { dbq } from "../../dbq.server";
import type { Run } from "./factory-runs.server";

const ago = (at: number, now: number): string => {
  const s = Math.max(0, now - at);
  if (s < 3600) return `hace ${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return `hace ${Math.round(s / 86400)} d`;
};

const cut = (t: string, n: number) => (t.length > n ? `${t.slice(0, n).trimEnd()}…` : t);

/** Un evento de la bitácora en un renglón: tipo, quién, cuándo y su dato corto. */
export function eventLine(e: { type: string; actor: string | null; at: number; data_json: string | null }, now: number): string {
  let extra = "";
  try {
    const d = e.data_json ? JSON.parse(e.data_json) : null;
    if (d && typeof d === "object") {
      const bits: string[] = [];
      if (d.from && d.to) bits.push(`${d.from}→${d.to}`);
      for (const k of ["text", "note", "findings", "pr", "behindBy", "conclusion"]) if (d[k] != null && d[k] !== "") bits.push(cut(String(d[k]), 140));
      extra = bits.length ? ` — ${bits.join(" · ")}` : "";
    }
  } catch {
    // dato no JSON: va sin detalle
  }
  return `- ${e.type}${e.actor ? ` (${e.actor})` : ""}, ${ago(e.at, now)}${extra}`;
}

/**
 * Estado de un pedido en texto. Compacto (≈1.5 KB) para la foto de cada turno; `detail` trae
 * el plan completo, todas las notas pendientes, 20 eventos, el veredicto y la preview.
 */
export async function runDigest(run: Run, opts: { detail?: boolean } = {}): Promise<string> {
  const detail = opts.detail === true;
  const now = Math.floor(Date.now() / 1000);
  const R = await import("./factory-runs.server");
  const { stageLabel } = await import("./factory-flow");
  const out: string[] = [];
  out.push(
    `Pedido #${run.id} «${run.title}» — etapa «${stageLabel(run.status)}», plan v${run.planVersion}` +
      (run.loops ? `, ${run.loops} vuelta(s) de check` : "") +
      (run.repo ? `, repo ${run.repo}` : "") +
      (run.branch ? `, rama ${run.branch}` : "") +
      (run.prUrl ? `, PR ${run.prUrl}` : ", sin PR todavía") +
      ".",
  );
  // Quién lo tiene AHORA: sin esto el rol decía «no te toca nada» con @build parado (MailMask, 4-oct).
  if (run.status !== "done" && run.status !== "cancelled") {
    const { runLive } = await import("./factory");
    const live = await runLive(run).catch(() => null);
    if (live)
      out.push(
        live.liveTurnId
          ? `Ahora: alguien está trabajando en el pedido${live.currentStep ? ` (${cut(String(live.currentStep), 80)})` : ""}.`
          : `Ahora: NADIE está trabajando en él (última actividad ${ago(live.lastActivityAt, now)}; ${live.view.label}).` +
              (live.view.stale ? " Está PARADO: si le toca a un rol, la persona lo destraba con «Retomar» en la barra del pedido." : ""),
      );
  }
  const [extra] = await dbq("SELECT verdict_json, sprint_item_id FROM gt_factory_runs WHERE id = ?", [run.id]).catch(() => []);
  // Ticket del sprint (el que lo creó o uno atado a él).
  const [item] = await dbq(
    `SELECT i.key, i.title, s.id AS sprint_id, s.title AS sprint_title, s.status AS sprint_status
     FROM gt_factory_sprint_items i JOIN gt_factory_sprints s ON s.id = i.sprint_id
     WHERE i.id = ? OR i.run_id = ? ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, s.id DESC LIMIT 1`,
    [extra?.sprint_item_id ?? -1, run.id],
  ).catch(() => []);
  if (item) out.push(`Es el ticket ${item.key} «${item.title}» del sprint #${item.sprint_id} «${item.sprint_title}» (${item.sprint_status}).`);
  const plan = run.planVersion ? await R.getPlan(run.id, run.planVersion).catch(() => null) : null;
  if (plan?.planMd) out.push(`Plan v${run.planVersion}${plan.decision ? ` (${plan.decision === "approve" ? "firmado" : plan.decision})` : ""}:\n${detail ? plan.planMd : cut(plan.planMd, 600)}`);
  const notes = await dbq(
    "SELECT by, text FROM gt_factory_notes WHERE run_id = ? AND consumed_at IS NULL ORDER BY id",
    [run.id],
  ).catch(() => []);
  if (notes.length)
    out.push(
      `Notas pendientes para @build (le llegan en su siguiente encargo):\n` +
        notes.map((n) => `- ${n.by}: ${detail ? String(n.text) : cut(String(n.text), 200)}`).join("\n"),
    );
  if (extra?.verdict_json) {
    try {
      const v = JSON.parse(String(extra.verdict_json));
      out.push(
        `Último veredicto de @check: CI ${v.ci ?? "?"}, riesgo ${v.risk ?? "?"}, ${v.ready ? "listo" : "no listo"}` +
          (v.findings ? `. Hallazgos: ${detail ? v.findings : cut(String(v.findings), 300)}` : "") +
          ".",
      );
    } catch {
      // veredicto ilegible: se omite
    }
  }
  const events = await dbq(
    "SELECT type, actor, at, data_json FROM gt_factory_events WHERE run_id = ? ORDER BY id DESC LIMIT ?",
    [run.id, detail ? 20 : 5],
  ).catch(() => []);
  if (events.length)
    out.push(
      `Últimos eventos (más reciente primero):\n` +
        events.map((e) => eventLine({ type: String(e.type), actor: e.actor ?? null, at: Number(e.at), data_json: e.data_json ?? null }, now)).join("\n"),
    );
  if (detail && run.prUrl) {
    const p = await R.runPreview(run.id).catch(() => null);
    if (p) out.push(`Preview: ${p.state}${p.url ? ` ${p.url}` : ""}${p.error ? ` (${cut(String(p.error), 200)})` : ""}.`);
  }
  return out.join("\n");
}

/**
 * Lo abierto del room en ≤ ~12 renglones: pedidos vivos y sprints activos o en borrador, con su
 * etapa, PR y última actividad. `closedDays` suma los cerrados de esos días (para la tool).
 */
export async function roomIndex(channelId: number, opts: { closedDays?: number } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const { stageLabel } = await import("./factory-flow");
  const since = opts.closedDays ? now - opts.closedDays * 86400 : null;
  const runs = await dbq(
    `SELECT id, title, status, pr_url, updated_at FROM gt_factory_runs
     WHERE channel_id = ? AND COALESCE(kind, '') != 'eval'
       AND (status NOT IN ('done', 'cancelled')${since ? " OR updated_at >= ?" : ""})
     ORDER BY id DESC LIMIT ?`,
    since ? [channelId, since, 20] : [channelId, 10],
  ).catch(() => []);
  const sprints = await dbq(
    `SELECT s.id, s.title, s.status, s.replaces,
            SUM(CASE WHEN i.included = 1 THEN 1 ELSE 0 END) AS total,
            SUM(CASE WHEN i.included = 1 AND i.status IN ('merged','skipped') THEN 1 ELSE 0 END) AS merged
     FROM gt_factory_sprints s LEFT JOIN gt_factory_sprint_items i ON i.sprint_id = s.id
     WHERE s.channel_id = ? AND s.status IN ('active', 'draft') GROUP BY s.id ORDER BY s.id DESC LIMIT 4`,
    [channelId],
  ).catch(() => []);
  const lines: string[] = [];
  for (const r of runs)
    lines.push(`- Pedido #${r.id} «${cut(String(r.title), 70)}» — ${stageLabel(r.status as import("./factory-flow").RunStatus)}${r.pr_url ? `, PR ${String(r.pr_url).replace(/^https:\/\/github\.com\//, "")}` : ""}, ${ago(Number(r.updated_at), now)}`);
  for (const s of sprints)
    lines.push(
      `- Sprint #${s.id} «${cut(String(s.title), 70)}» — ${s.status === "draft" ? "borrador (falta firma)" : "activo"}, ${Number(s.merged ?? 0)}/${Number(s.total ?? 0)} tickets` +
        (s.replaces ? `, reemplaza al #${s.replaces}` : ""),
    );
  return lines.length ? lines.join("\n") : "Sin pedidos ni sprints abiertos en este room.";
}
