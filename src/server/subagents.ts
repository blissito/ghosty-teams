// El detalle de UN subagente para el panel lateral (`ArtifactPanel` kind "subagent"): tarea
// completa, contadores, bitácora de pasos y resultado. Vive en gs (`SubagentRun`); aquí sólo
// se pide con la firma de partner del runtime nativo, igual que el turno.
import { createServerFn } from "@tanstack/react-start";
import { sessionUser } from "./chat";

export type SubagentDetail = {
  id: string;
  name: string;
  task: string;
  status: string;
  startedAt: number | null;
  ms: number | null;
  toolUses: number;
  tokens: number;
  steps: { at: number; tool: string; detail: string }[];
  resultMd: string | null;
};

export const subagentDetailFn = createServerFn({ method: "POST" })
  .validator((d: { handle: string; runId: string }) => d)
  .handler(async ({ data }): Promise<SubagentDetail | null> => {
    const me = await sessionUser();
    if (!me) return null;
    const { resolvedAgents } = await import("../agents.server");
    const agent = (await resolvedAgents()).find((a) => a.handle === data.handle);
    if (!agent || agent.backend.kind !== "fleet") return null;
    const { runtimeFor } = await import("./agent-runtime.server");
    const rt = await runtimeFor(agent.backend);
    // Sólo el runtime nativo guarda subagentes con detalle.
    if (rt.transport !== "http" || rt.kind !== "gs-native") return null;
    const url = `${rt.base}/api/v2/fleet-agents/${agent.backend.id}/subagent-runs/${encodeURIComponent(data.runId)}`;
    const res = await fetch(url, { headers: rt.headers("", agent.backend.token ?? "") }).catch(() => null);
    if (!res?.ok) return null;
    const j = (await res.json().catch(() => null)) as Partial<SubagentDetail> | null;
    if (!j?.id) return null;
    return {
      id: String(j.id),
      name: String(j.name ?? "Subagente"),
      task: String(j.task ?? ""),
      status: String(j.status ?? "running"),
      startedAt: typeof j.startedAt === "number" ? j.startedAt : null,
      ms: typeof j.ms === "number" ? j.ms : null,
      toolUses: Number(j.toolUses ?? 0),
      tokens: Number(j.tokens ?? 0),
      steps: Array.isArray(j.steps) ? j.steps.slice(-50).map((x) => ({ at: Number(x.at ?? 0), tool: String(x.tool ?? ""), detail: String(x.detail ?? "") })) : [],
      resultMd: j.resultMd != null ? String(j.resultMd) : null,
    };
  });
