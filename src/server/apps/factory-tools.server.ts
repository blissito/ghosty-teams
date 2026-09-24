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

/** Por qué un plan no se acepta (null = pasa). El 2026-09-24 @plan en deepseek-v4-flash
 *  «probó» la tool con «Markdown Markdown…» y «SONDEO DE CAMPO… relleno relleno…»: las dos
 *  pasaban el mínimo de 40 caracteres y quedaron como v1 y v2 esperando firma. Un plan de
 *  verdad (historia, criterios, brief, riesgos) nunca baja de ~25 palabras distintas. */
export function planRejection(planMd: string): string | null {
  if (planMd.length < 200) return "el plan está vacío o demasiado corto: entrega el plan real completo, no una prueba";
  const words = planMd.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (new Set(words).size < 25)
    return "esto no es un plan (texto de relleno o repetido). No pruebes la tool: llámala UNA vez con el plan real";
  return null;
}

export type SuggestedAsk = { size: "chico" | "mediano" | "grande"; title: string; ask: string; why: string };

/** Valida los pedidos sugeridos (string = por qué no). Un `ask` corto no es un pedido. */
export function suggestItems(raw: unknown): SuggestedAsk[] | string {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 5) return "manda de 2 a 5 pedidos";
  const out: SuggestedAsk[] = [];
  for (const it of raw as Record<string, unknown>[]) {
    const size = String(it?.size ?? "");
    const title = String(it?.title ?? "").trim().slice(0, 80);
    const ask = String(it?.ask ?? "").trim().replace(/^@plan\s+/i, "").slice(0, 600);
    const why = String(it?.why ?? "").trim().slice(0, 200);
    if (!["chico", "mediano", "grande"].includes(size)) return "size va como chico, mediano o grande";
    if (!title || !why) return "cada pedido lleva title y why";
    if (ask.length < 40) return `el pedido «${title}» es muy corto: escribe el mensaje completo que recibirías`;
    out.push({ size: size as SuggestedAsk["size"], title, ask, why });
  }
  return out;
}

/** Título de la corrida: el explícito, o el primer encabezado/renglón del plan. */
export function planTitle(title: unknown, planMd: string): string {
  const t = String(title ?? "").trim() || (planMd.match(/^#+\s*(.+)$/m)?.[1] ?? planMd.split("\n")[0]);
  return t.replace(/^#+\s*/, "").trim().slice(0, 120);
}

function runTools(dest: ToolDest | null): ConnectorTool[] {
  return [
    {
      name: "factory_plan_submit",
      description:
        "SÓLO @plan. Entrega el plan de un pedido de la Software Factory para que una persona lo firme: " +
        "crea el pedido (si es nuevo) o una versión nueva del plan (si te pidieron cambios). Publica la " +
        "tarjeta con Aprobar / Pedir cambios en el hilo del pedido. No construyas nada: al firmarse, la plataforma " +
        "despierta a @build. `plan_md` en markdown: historia con criterios de aceptación, brief técnico y riesgos.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Título corto del pedido (primera versión)" },
          plan_md: { type: "string", description: "El plan completo en markdown" },
          repo: { type: "string", description: 'Repo "dueño/repo" (si el room tiene varios)' },
          runId: { type: "number", description: "Pedido existente (si no, se toma el del hilo)" },
        },
        required: ["plan_md"],
      },
      handler: async (sub, a) => {
        if (dest?.handle && dest.handle !== "plan") return { ok: false, error: "sólo @plan entrega planes" };
        if (!dest?.channelId) return { ok: false, error: "la fábrica trabaja en un room, no en un DM" };
        const planMd = String(a.plan_md ?? "").trim();
        const rejected = planRejection(planMd);
        if (rejected) return { ok: false, error: rejected };
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
            [dest.channelId, root, dest.topic || "general", planTitle(a.title, planMd), repo, sub],
          );
          run = (await R.getRun(Number(rows[0].id)))!;
        }
        const version = run.planVersion + 1;
        const firstPlan = run.planVersion === 0;
        // El título sigue al plan vigente: antes se congelaba con la primera versión y viajaba
        // así a @build, @check, la tarjeta y la tarea.
        const title = planTitle(a.title, planMd);
        if (!firstPlan && title && title !== run.title) {
          await dbq("UPDATE gt_factory_runs SET title = ? WHERE id = ?", [title, run.id]);
          run = { ...run, title };
        }
        run = await R.applyEvent(run, "plan_submitted", { plan_version: version });
        await dbq("INSERT INTO gt_factory_plans (run_id, version, plan_md) VALUES (?, ?, ?)", [run.id, version, planMd]);
        const msgId = await R.postInThread(run, "plan", R.planCardFence(run.id, version));
        if (msgId) await dbq("UPDATE gt_factory_plans SET msg_id = ? WHERE run_id = ? AND version = ?", [msgId, run.id, version]);
        if (firstPlan) void R.createTaskFor(run, planMd).catch(() => {});
        // La tarjeta viva en el room (la primera vez) y el aviso de que hay plan nuevo.
        await R.ensureRunCard(run);
        void R.refreshRoom(run.channelId);
        return {
          ok: true,
          runId: run.id,
          version,
          note: `Tarjeta publicada en el hilo. Ahora espera la firma: no construyas. Di en una línea qué necesita revisar la persona. Si lo nombras, es el «pedido #${run.id}» (nunca «corrida»).`,
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
          runId: { type: "number", description: "El pedido (si no, el del hilo)" },
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
        if (!run) return { ok: false, error: "no encuentro el pedido de este hilo" };
        const url = String(a.pr_url ?? "");
        if (!R.parsePrUrl(url)) return { ok: false, error: "pr_url tiene que ser la URL de un PR de GitHub" };
        // CI en rojo no llega a @check: se ahorra una vuelta y lo arregla quien construyó.
        const ci = await R.prCi(sub, url);
        if (ci?.state === "failure") {
          return {
            ok: false,
            error: `el CI del PR falló (${ci.failed.join(", ") || "ver checks"}). Lee el log con github_workflow_run_logs, corrígelo en la misma rama y vuelve a cerrar.`,
          };
        }
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
            `Lee el diff con github_pr_files y el CI con github_pr_checks. Si el CI sigue corriendo, usa ` +
            `github_watch_pr y espera el aviso antes de dar tu veredicto (no apruebes con CI pendiente). ` +
            `NO edites ni empujes nada. ` +
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
          runId: { type: "number", description: "El pedido (si no, el del hilo)" },
          pass: { type: "boolean", description: "true = listo para revisión humana" },
          findings: { type: "string", description: "Hallazgos (obligatorio si pass=false), en markdown breve" },
        },
        required: ["pass"],
      },
      handler: async (sub, a) => {
        if (dest?.handle && dest.handle !== "check") return { ok: false, error: "sólo @check da el veredicto" };
        const R = await import("./factory-runs.server");
        const run = await runOf(dest, a.runId);
        if (!run) return { ok: false, error: "no encuentro el pedido de este hilo" };
        if (run.status !== "checking") return { ok: false, error: `el pedido no está en revisión (está en ${run.status})` };
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
        // Aprobar exige CI en verde, verificado aquí y no en la palabra del modelo. `none` (el
        // repo no tiene CI) se permite, pero se dice en la tarjeta.
        let ciNote = "";
        if (a.pass === true && run.prUrl) {
          const ci = await R.prCi(sub, run.prUrl);
          if (ci?.state === "pending")
            return { ok: false, error: "el CI todavía corre: usa github_watch_pr y da tu veredicto cuando termine." };
          if (ci?.state === "failure")
            return { ok: false, error: `el CI está en rojo (${ci.failed.join(", ") || "ver checks"}): no puede pasar. Repórtalo con pass=false.` };
          if (ci?.state === "none") ciNote = "\n\n⚠️ Este repo no tiene CI: nada corrió las pruebas fuera de la caja.";
        }
        if (a.pass === true) {
          const next = await R.applyEvent(run, "check_pass");
          // Sacarlo de borrador lo hace la plataforma, no el prompt: antes dependía de que
          // @check se acordara de github_mark_ready, y la tarjeta ya decía «listo».
          const ready = run.prUrl ? await R.markPrReady(sub, run.prUrl) : false;
          const draftNote = run.prUrl && !ready ? "\n\n⚠️ No pude sacar el PR de borrador: márcalo listo en GitHub." : "";
          await R.postInThread(
            next,
            "check",
            `✅ **Listo para tu revisión** — pasó el check contra el plan v${run.planVersion}${ready ? " y el PR ya no es borrador" : ""}.${findings ? `\n\n${findings}` : ""}${ciNote}${draftNote}\n\n${run.prUrl ?? ""}`,
          );
          return { ok: true, status: next.status, note: "La plataforma ya avisó en el hilo y sacó el PR de borrador. Termina sin repetirlo." };
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
        "Cierra el pedido de este hilo cuando una PERSONA lo pide o el PR ya se mezcló: outcome=merged (terminada) " +
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
        if (!run) return { ok: false, error: "no hay pedido en este hilo" };
        const next = await R.applyEvent(run, a.outcome === "merged" ? "close" : "cancel");
        return { ok: true, status: next.status };
      },
    },
    {
      name: "factory_suggest",
      description:
        "SÓLO @plan. Cuando te llaman sin un pedido concreto (o te encargan sugerir), propone de 2 a 5 pedidos listos " +
        "para mandar, leídos del repo del room. La plataforma publica una tarjeta con un botón «Pedir» por pedido: " +
        "quien lo pulsa te lo manda tal cual en su propio hilo. Cada `ask` es el mensaje completo que recibirías " +
        "(sin «@plan»): concreto, con archivos o funciones por nombre y el límite de alcance. Prefiere agregar " +
        "(pruebas, validaciones, TODOs chicos) sobre borrar; nada que borre datos, archivos de producción o historial. " +
        "Después de llamarla, NO repitas la lista en tu respuesta.",
      inputSchema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            minItems: 2,
            maxItems: 5,
            items: {
              type: "object",
              properties: {
                size: { type: "string", enum: ["chico", "mediano", "grande"] },
                title: { type: "string", description: "Título corto (máx. 60 caracteres)" },
                ask: { type: "string", description: "El pedido tal cual te llegaría, sin «@plan»" },
                why: { type: "string", description: "Por qué vale la pena, en una línea" },
              },
              required: ["size", "title", "ask", "why"],
            },
          },
        },
        required: ["items"],
      },
      handler: async (_sub, a) => {
        if (dest?.handle && dest.handle !== "plan") return { ok: false, error: "sólo @plan sugiere pedidos" };
        if (!dest?.channelId) return { ok: false, error: "sin room no hay dónde publicar" };
        const items = suggestItems(a.items);
        if (typeof items === "string") return { ok: false, error: items };
        const db = await import("../../db.server");
        const ch = await db.getChannelById(dest.channelId);
        if (!ch) return { ok: false, error: "room no encontrado" };
        const { resolvedAgents } = await import("../../agents.server");
        const me = (await resolvedAgents()).find((x) => x.handle === "plan");
        const body = "```gt-asks\n" + JSON.stringify({ roomSlug: ch.slug, items }) + "\n```";
        const { id } = await db.postAgent(dest.channelId, threadRoot(dest), body, "msg", "plan", me?.name ?? "plan", dest.topic || "general", me?.avatar ?? "");
        const bus = await import("../bus.server");
        const { currentNamespace } = await import("../tenant.server");
        const msg = await db.getMessage(id);
        if (msg) bus.publish(bus.ch.room(await currentNamespace(), dest.channelId), { t: "message:new", msg });
        return { ok: true, published: items.length, note: "Tarjeta publicada. Termina con una sola línea (o nada): la lista ya está en la tarjeta." };
      },
    },
    {
      name: "factory_status",
      description: "Estado del pedido de este hilo (o de runId): etapa, versión del plan, vueltas, PR y tarea.",
      inputSchema: { type: "object", properties: { runId: { type: "number" } } },
      handler: async (_sub, a) => {
        const run = await runOf(dest, a.runId);
        if (!run) return { ok: false, error: "no hay pedido en este hilo" };
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
        `Pedido de ESTE hilo: #${run.id} «${run.title}», etapa «${stageLabel(run.status)}», plan v${run.planVersion}` +
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
