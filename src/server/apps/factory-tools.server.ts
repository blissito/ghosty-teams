// Tools de la Software Factory. SÓLO existen en un espacio que la tiene instalada
// (`gt_installed_apps`): sin la fila, esto devuelve [] y ni se anuncian ni se ejecutan.
// Decidido 2026-09-24 — la fábrica se INSTALA por espacio y sus tools aparecen con ella.
//
// Hoy: el webhook genérico de alertas de monitoreo. Las `factory_*` (corrida, estafeta,
// tarjeta de plan) se suman aquí mismo.
import { notaNombres, type ConnectorTool, type ToolChannel } from "../connectors/impl";
import type { ToolDest } from "../connectors/tool-token.server";
import { isInstalled } from "./installed.server";

export async function factoryTools(_sub: string, dest: ToolDest | null): Promise<ConnectorTool[]> {
  if (!(await isInstalled("factory").catch(() => false))) return [];
  const { alertWebhookTools } = await import("../hooks/generic-alert.server");
  return [...runTools(dest), ...alertWebhookTools(dest)];
}

const origin = async () => {
  const { reqOrigin } = await import("../../origin.server");
  return reqOrigin().catch(() => "");
};

/** Hilo del turno: la raíz del hilo si estamos en uno; si no, el mensaje que invocó. */
function threadRoot(dest: ToolDest | null): number | null {
  if (!dest?.channelId) return null;
  return dest.parentId ?? dest.invokerMessageIds?.[0] ?? null;
}

async function runOf(dest: ToolDest | null, runId: unknown) {
  const R = await import("./factory-runs.server");
  const id = Number(runId);
  if (Number.isFinite(id) && id > 0) {
    // Sólo corridas de ESTE room: con el id de otra, un agente invocado aquí leería o movería
    // la de un room privado ajeno.
    const run = await R.getRun(id);
    return run && run.channelId === dest?.channelId ? run : null;
  }
  const root = threadRoot(dest);
  return dest?.channelId && root ? R.runOfThread(dest.channelId, root) : null;
}

function runTools(dest: ToolDest | null): ConnectorTool[] {
  return [
    {
      name: "factory_plan_submit",
      description:
        "SÓLO @plan. Entrega el plan de una corrida de la Software Factory para que una persona lo firme: " +
        "crea la corrida (si es un pedido nuevo) o una versión nueva del plan (si te pidieron cambios). Publica la " +
        "tarjeta con Aprobar / Pedir cambios en el hilo del pedido. No construyas nada: al firmarse, la plataforma " +
        "despierta a @build. `plan_md` en markdown: historia con criterios de aceptación, brief técnico y riesgos.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Título corto del pedido (primera versión)" },
          plan_md: { type: "string", description: "El plan completo en markdown" },
          repo: { type: "string", description: 'Repo "dueño/repo" (si el room tiene varios)' },
          runId: { type: "number", description: "Corrida existente (si no, se toma la del hilo)" },
        },
        required: ["plan_md"],
      },
      handler: async (sub, a) => {
        if (dest?.handle && dest.handle !== "plan") return { ok: false, error: "sólo @plan entrega planes" };
        if (!dest?.channelId) return { ok: false, error: "la fábrica trabaja en un room, no en un DM" };
        const planMd = String(a.plan_md ?? "").trim();
        if (planMd.length < 40) return { ok: false, error: "el plan está vacío o demasiado corto" };
        const R = await import("./factory-runs.server");
        const { dbq } = await import("../../dbq.server");
        let run = await runOf(dest, a.runId);
        if (!run) {
          let root = threadRoot(dest);
          if (!root) {
            // Turno sin hilo (una tarea programada despierta a @plan top-level): el pedido
            // nace aquí, con su cara, y la corrida cuelga de él.
            const db0 = await import("../../db.server");
            const bus = await import("../bus.server");
            const { currentNamespace } = await import("../tenant.server");
            const head = "🗓️ Revisión programada";
            const title0 = String(a.title || planMd.split("\n")[0]).replace(/^#+\s*/, "").slice(0, 120);
            const posted = await db0.postAgent(dest.channelId, null, `**${head}:** ${title0}`, "msg", dest.handle || "plan", dest.name || "Plan", dest.topic || "general", dest.avatar || "");
            const msg = await db0.getMessage(posted.id);
            if (msg) bus.publish(bus.ch.room(await currentNamespace(), dest.channelId), { t: "message:new", msg });
            root = posted.id;
          }
          const db = await import("../../db.server");
          const repos = (await db.listRoomRepos(dest.channelId)).map((r) => r.repo);
          const repo = a.repo ? String(a.repo) : repos.length === 1 ? repos[0] : null;
          const rows = await dbq(
            `INSERT INTO gt_factory_runs (channel_id, root_msg_id, topic, title, status, repo, requested_by)
             VALUES (?, ?, ?, ?, 'planning', ?, ?) RETURNING id`,
            [dest.channelId, root, dest.topic || "general", String(a.title || planMd.split("\n")[0]).replace(/^#+\s*/, "").slice(0, 120), repo, sub],
          );
          run = (await R.getRun(Number(rows[0].id)))!;
        }
        const version = run.planVersion + 1;
        const firstPlan = run.planVersion === 0;
        run = await R.applyEvent(run, "plan_submitted", { plan_version: version });
        await dbq("INSERT INTO gt_factory_plans (run_id, version, plan_md) VALUES (?, ?, ?)", [run.id, version, planMd]);
        const msgId = await R.postInThread(run, "plan", R.planCardFence(run.id, version));
        if (msgId) await dbq("UPDATE gt_factory_plans SET msg_id = ? WHERE run_id = ? AND version = ?", [msgId, run.id, version]);
        if (firstPlan) void R.createTaskFor(run, planMd).catch(() => {});
        return {
          ok: true,
          runId: run.id,
          version,
          note: "Tarjeta publicada en el hilo. Ahora espera la firma: no construyas. Di en una línea qué necesita revisar la persona.",
        };
      },
    },
    {
      name: "factory_build_done",
      description:
        "SÓLO @build. Cierra tu paso cuando el PR en BORRADOR está abierto y las pruebas corrieron: la plataforma " +
        "despierta a @check con el plan aprobado y el PR. Si @check te regresó hallazgos, corrígelos en la MISMA rama y " +
        "vuelve a llamar esto.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "number", description: "La corrida (si no, la del hilo)" },
          pr_url: { type: "string", description: "URL del PR en GitHub" },
          branch: { type: "string", description: "Rama del PR" },
          tests: { type: "string", description: "Resultado de pruebas, lint y typecheck, en una o dos líneas" },
        },
        required: ["pr_url", "tests"],
      },
      handler: async (sub, a) => {
        if (dest?.handle && dest.handle !== "build") return { ok: false, error: "sólo @build cierra la construcción" };
        const R = await import("./factory-runs.server");
        const run = await runOf(dest, a.runId);
        if (!run) return { ok: false, error: "no encuentro la corrida de este hilo" };
        const url = String(a.pr_url ?? "");
        if (!R.parsePrUrl(url)) return { ok: false, error: "pr_url tiene que ser la URL de un PR de GitHub" };
        const head = await R.prHead(sub, url);
        const next = await R.applyEvent(run, "build_done", {
          pr_url: url,
          branch: a.branch ? String(a.branch) : run.branch,
          head_sha: head?.sha ?? null,
        });
        if (!run.prUrl) void R.linkPrToTask(next, url);
        const plan = await R.getPlan(run.id, run.planVersion);
        await R.handoff(
          next,
          "check",
          sub,
          "revisar el PR",
          `Revisa el PR ${url} contra el plan APROBADO (v${run.planVersion}). Resultado que reporta @build: ${String(a.tests).slice(0, 500)}\n\n` +
            `## Plan aprobado\n${plan?.planMd ?? "(no encontré el plan)"}\n\n` +
            `Lee el diff con github_pr_files y el CI con github_pr_checks. NO edites ni empujes nada. ` +
            `Cierra con factory_check_verdict (runId ${run.id}).`,
          await origin(),
        );
        return { ok: true, runId: run.id, status: next.status, note: "@check ya tiene el encargo. Tu paso terminó." };
      },
    },
    {
      name: "factory_check_verdict",
      description:
        "SÓLO @check. Tu veredicto sobre el PR: pass=true si cumple el plan y está listo para que una persona lo " +
        "revise; pass=false con hallazgos concretos (archivo:línea y qué falta) y la plataforma se lo regresa a @build. " +
        "Nunca edites ni empujes código: si la cabeza del PR cambió durante tu revisión, el veredicto se rechaza.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "number", description: "La corrida (si no, la del hilo)" },
          pass: { type: "boolean", description: "true = listo para revisión humana" },
          findings: { type: "string", description: "Hallazgos (obligatorio si pass=false), en markdown breve" },
        },
        required: ["pass"],
      },
      handler: async (sub, a) => {
        if (dest?.handle && dest.handle !== "check") return { ok: false, error: "sólo @check da el veredicto" };
        const R = await import("./factory-runs.server");
        const run = await runOf(dest, a.runId);
        if (!run) return { ok: false, error: "no encuentro la corrida de este hilo" };
        if (run.status !== "checking") return { ok: false, error: `la corrida no está en revisión (está en ${run.status})` };
        // La regla de @check se cumple aquí, no en su prompt: si la cabeza del PR se movió
        // desde que @build cerró, alguien empujó durante la revisión.
        if (run.prUrl && run.headSha) {
          const head = await R.prHead(sub, run.prUrl);
          if (head && head.sha !== run.headSha) {
            return {
              ok: false,
              error: "la cabeza del PR cambió durante la revisión: @check no empuja código. Reporta hallazgos con pass=false para que @build los corrija.",
            };
          }
        }
        const findings = String(a.findings ?? "").trim();
        if (a.pass === true) {
          const next = await R.applyEvent(run, "check_pass");
          await R.postInThread(
            next,
            "check",
            `✅ **Listo para tu revisión** — pasó el check contra el plan v${run.planVersion}.${findings ? `\n\n${findings}` : ""}\n\n${run.prUrl ?? ""}`,
          );
          return { ok: true, status: next.status, note: "Márcalo listo para revisión con github_mark_ready y avisa en una línea." };
        }
        if (!findings) return { ok: false, error: "con pass=false los hallazgos son obligatorios" };
        const next = await R.applyEvent(run, "check_fail", { loops: run.loops + 1 });
        if (next.status === "escalated") {
          await R.postInThread(
            next,
            "check",
            `⚠️ **Necesita una decisión** — ${run.loops + 1} vueltas entre @build y @check sin cerrar. Lo último que encontré:\n\n${findings}\n\n` +
              `Contesta «✅» para otra vuelta de @build, o «cambios: …» para replanear.`,
          );
          return { ok: true, status: next.status };
        }
        await R.handoff(
          next,
          "build",
          // Con las credenciales de quien firmó (la 1ª construcción también): quien pidió
          // puede no tener GitHub.
          next.approvedBy ?? next.requestedBy,
          "corregir hallazgos de @check",
          `@check regresó el PR ${run.prUrl ?? ""} (vuelta ${next.loops} de 3). Corrige en la MISMA rama y cierra otra vez con factory_build_done (runId ${run.id}).\n\n## Hallazgos\n${findings}`,
          await origin(),
        );
        return { ok: true, status: next.status, note: "Regresado a @build." };
      },
    },
    {
      name: "factory_close",
      description:
        "Cierra la corrida de este hilo cuando una PERSONA lo pide o el PR ya se mezcló: outcome=merged (terminada) " +
        "o cancelled (se abandona). Mueve la tarea a Done y libera el hilo para un pedido nuevo. Nunca la cierres por tu cuenta.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "number" },
          outcome: { type: "string", enum: ["merged", "cancelled"] },
        },
        required: ["outcome"],
      },
      handler: async (_sub, a) => {
        const R = await import("./factory-runs.server");
        const run = await runOf(dest, a.runId);
        if (!run) return { ok: false, error: "no hay corrida en este hilo" };
        const next = await R.applyEvent(run, a.outcome === "merged" ? "close" : "cancel");
        return { ok: true, status: next.status };
      },
    },
    {
      name: "factory_status",
      description: "Estado de la corrida de este hilo (o de runId): etapa, versión del plan, vueltas, PR y tarea.",
      inputSchema: { type: "object", properties: { runId: { type: "number" } } },
      handler: async (_sub, a) => {
        const run = await runOf(dest, a.runId);
        if (!run) return { ok: false, error: "no hay corrida en este hilo" };
        const { stageLabel } = await import("./factory-flow");
        return { ok: true, ...run, stage: stageLabel(run.status) };
      },
    },
  ];
}

/** Bloque de contexto del turno: el papel del rol, la corrida del hilo y las alertas. null sin la app. */
export async function factoryContext(dest: ToolDest | null, toolChannel: ToolChannel = "gs-sdk"): Promise<string | null> {
  if (!(await isInstalled("factory").catch(() => false))) return null;
  const parts: string[] = ["[SOFTWARE FACTORY instalada en este espacio: @plan planea, @build construye, @check revisa; la plataforma pasa la estafeta y pide la firma humana."];
  // Las instrucciones del ROL van aquí, por turno y según el handle con que te invocaron: el
  // agente es uno de Studio con su propia identidad, y sólo actúa este rol cuando es @plan,
  // @build o @check (ver apps/factory-roles.ts).
  const { FACTORY_COMMON, ROLE_INSTRUCTIONS, FACTORY_HANDLES } = await import("./factory-roles");
  const h = dest?.handle as (typeof FACTORY_HANDLES)[number] | undefined;
  if (h && (FACTORY_HANDLES as readonly string[]).includes(h)) {
    parts.push(`En ESTE turno actúas como @${h}; tu identidad de siempre se queda, pero aplica este rol.`);
    parts.push(FACTORY_COMMON);
    parts.push(ROLE_INSTRUCTIONS[h]);
  }
  const root = threadRoot(dest);
  if (dest?.channelId && root) {
    const R = await import("./factory-runs.server");
    const run = await R.runOfThread(dest.channelId, root).catch(() => null);
    if (run) {
      const { stageLabel } = await import("./factory-flow");
      parts.push(
        `Corrida de ESTE hilo: #${run.id} «${run.title}», etapa «${stageLabel(run.status)}», plan v${run.planVersion}` +
          (run.prUrl ? `, PR ${run.prUrl}` : "") +
          (run.loops ? `, ${run.loops} vuelta(s) de check` : "") +
          ". Usa su runId en las tools factory_*.",
      );
    }
  }
  // Misma frase que Tasks: tenerlas y no llamarlas es el otro modo de falla.
  parts.push(
    "Tus tools de la fábrica (factory_plan_submit, factory_build_done, factory_check_verdict, factory_status, factory_close) " +
      "ya están disponibles en este turno: LLÁMALAS para cerrar tu paso; sin ellas la estafeta no avanza." +
      notaNombres(toolChannel),
  );
  parts.push(
    "ALERTAS DE MONITOREO: si piden conectar su monitoreo (Datadog, Grafana, Better Stack, UptimeRobot o cualquier herramienta con webhooks), usa alert_webhook_create { name } en el canal donde deben caer; la URL es SECRETA (sólo a quien la pidió). También alert_webhook_list y alert_webhook_delete. Para Sentry usa su conector.]",
  );
  return parts.join(" ");
}
