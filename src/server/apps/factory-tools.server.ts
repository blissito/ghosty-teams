// Tools de la Software Factory. SÓLO existen en un espacio que la tiene instalada
// (`gt_installed_apps`): sin la fila, esto devuelve [] y ni se anuncian ni se ejecutan.
// Decidido 2026-09-24 — la fábrica se INSTALA por espacio y sus tools aparecen con ella.
//
// Hoy: el webhook genérico de alertas de monitoreo y el uptime del room (`uptime_*`). Las
// `factory_*` (corrida, estafeta, tarjeta de plan) se suman aquí mismo.
import { notaNombres, type ConnectorTool, type ToolChannel } from "../connectors/impl";
import type { ToolDest } from "../connectors/tool-token.server";
import { isInstalled } from "./installed.server";
import { MAX_LOOPS, clipReason, countsLoop, isEscalationKind, isGithubRateLimit, stageLabel, type EscalationKind } from "./factory-flow";
import type { EnvRiskEntry } from "./factory-preview-gate";
import { ESCALATION_TITLE } from "./factory-brief";
import { parseSeverity, type Severity } from "../automations/severity";

export async function factoryTools(_sub: string, dest: ToolDest | null): Promise<ConnectorTool[]> {
  if (!(await isInstalled("factory").catch(() => false))) return [];
  const { alertWebhookTools } = await import("../hooks/generic-alert.server");
  const { uptimeTools } = await import("./uptime.server");
  return [...runTools(dest), ...alertWebhookTools(dest), ...uptimeTools(dest)];
}

/** Tope de `factory_message` por pedido y por rol que escribe: evita el ping-pong entre agentes. */
const MAX_ROLE_MESSAGES = 6;

const ESCALATION_ASK: Record<EscalationKind, string> = {
  env: "Guarda las variables (con datos de prueba) y luego «Que @check revise».",
  fix: "Decide en la tarjeta de abajo: «Que @build lo arregle» o «Rehacer el plan».",
  skip: "Decide en la tarjeta de abajo: «Cerrar PR», «Cerrar e ignorar esta versión» o «Que @build lo arregle».",
  decision: "Decide en la tarjeta de abajo: «¿Qué hago?», «Que @build lo arregle» o «Rehacer el plan».",
  platform: "Nadie tiene que decidir: se reintenta sola.",
};

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

/**
 * PRs que menciona un texto: la URL completa (`github.com/o/r/pull/8`) o `#8` suelto, que
 * sólo se puede atar a un repo del room (`repo: null`). Sin duplicados.
 */
export function prMentions(text: string): { repo: string | null; number: number }[] {
  const out: { repo: string | null; number: number }[] = [];
  const seen = new Set<string>();
  const push = (repo: string | null, number: number) => {
    const k = `${repo?.toLowerCase() ?? ""}#${number}`;
    if (!seen.has(k) && number > 0) (seen.add(k), out.push({ repo, number }));
  };
  for (const m of String(text ?? "").matchAll(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/gi)) push(m[1], Number(m[2]));
  for (const m of String(text ?? "").matchAll(/(?:^|[\s(])#(\d{1,6})\b/g)) push(null, Number(m[1]));
  return out;
}

/**
 * Pedidos de la fábrica cuyo PR menciona este hilo SIN ser el hilo del pedido: la tarjeta del
 * PR en la raíz, o «#8» / la URL en la raíz o en el mensaje que invocó. Más reciente primero.
 * Si se da `sub`, sólo los de rooms que esa persona ve (una nota no cruza a un privado ajeno).
 */
export async function runsMentionedInThread(dest: ToolDest | null, sub?: string) {
  const root = threadRoot(dest);
  if (!dest?.channelId || !root) return [];
  const db = await import("../../db.server");
  const R = await import("./factory-runs.server");
  const { prOfMessage } = await import("../../lib/ebdoc");
  const bodies: string[] = [];
  for (const id of new Set([root, ...(dest.invokerMessageIds ?? [])])) {
    const m = await db.getMessage(id).catch(() => null);
    if (m?.body) bodies.push(m.body);
  }
  // Y las últimas respuestas del hilo: el «PR #8» suele decirlo un agente, no la raíz ni quien
  // invocó, y sin leerlas la nota no encontraba su pedido (MailMask, 4-oct).
  const replies = await db.listThread(root).catch(() => []);
  for (const m of replies.slice(-10).reverse()) if (m.body) bodies.push(m.body);
  const prs: { repo: string; number: number }[] = [];
  const card = bodies[0] ? prOfMessage(bodies[0]) : null;
  if (card) prs.push({ repo: card.repo, number: card.number });
  const repos = (await db.listRoomRepos(dest.channelId).catch(() => [])).map((r) => r.repo);
  for (const m of bodies.flatMap(prMentions)) {
    if (m.repo) prs.push({ repo: m.repo, number: m.number });
    else for (const repo of repos) prs.push({ repo, number: m.number });
  }
  const byId = new Map<number, Awaited<ReturnType<typeof R.runsByPr>>[number]>();
  for (const pr of prs) for (const run of await R.runsByPr(pr.repo, pr.number)) byId.set(run.id, run);
  let runs = [...byId.values()];
  if (sub) {
    const visible = new Set((await db.listChannels(sub, false).catch(() => [])).map((c) => c.id));
    runs = runs.filter((r) => r.channelId === dest.channelId || visible.has(r.channelId));
  }
  return runs.sort((a, b) => b.id - a.id);
}

/**
 * Pedido dueño de un PR dado como número («8», «#8») o URL. El número se ata a los repos del
 * room; sólo pedidos de este room o de uno que `sub` vea. El más reciente si hay varios.
 */
export async function runOfPr(dest: ToolDest | null, sub: string, pr: unknown) {
  if (pr == null || pr === "" || !dest?.channelId) return null;
  const db = await import("../../db.server");
  const R = await import("./factory-runs.server");
  const raw = String(pr).trim();
  const url = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i.exec(raw);
  const n = url ? Number(url[2]) : Number(raw.replace(/^#/, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  const repos = url ? [url[1]] : (await db.listRoomRepos(dest.channelId).catch(() => [])).map((r) => r.repo);
  const visible = new Set((await db.listChannels(sub, false).catch(() => [])).map((c) => c.id));
  const runs = (await Promise.all(repos.map((repo) => R.runsByPr(repo, n)))).flat();
  return runs.filter((r) => r.channelId === dest.channelId || visible.has(r.channelId)).sort((a, b) => b.id - a.id)[0] ?? null;
}

/**
 * El pedido de una nota: el `runId` explícito (de este room o de uno que `sub` vea), el del PR
 * explícito, el del hilo, o el del PR que el hilo menciona. null si no hay pedido.
 */
export async function resolveNoteRun(dest: ToolDest | null, sub: string, runId: unknown, pr?: unknown) {
  const R = await import("./factory-runs.server");
  if (pr != null && pr !== "") return runOfPr(dest, sub, pr);
  const id = Number(runId);
  if (Number.isFinite(id) && id > 0) {
    const run = await R.getRun(id);
    if (!run) return null;
    if (run.channelId === dest?.channelId) return run;
    const db = await import("../../db.server");
    const visible = (await db.listChannels(sub, false).catch(() => [])).some((c) => c.id === run.channelId);
    return visible ? run : null;
  }
  const own = await runOf(dest, undefined);
  if (own) return own;
  return (await runsMentionedInThread(dest, sub))[0] ?? null;
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

export type SuggestedAsk = { size: "chico" | "mediano" | "grande"; title: string; ask: string; why: string; repo?: string };

/** Valida los pedidos sugeridos (string = por qué no). Un `ask` corto no es un pedido. */
export function suggestItems(raw: unknown, repos: string[] = [], from = "plan"): SuggestedAsk[] | string {
  // @plan reparte opciones (2–5); @build y @check proponen lo que salió en su trabajo o lo que
  // la persona les pidió fuera del pedido (1–3).
  const [min, max] = from === "plan" ? [2, 5] : [1, 3];
  if (!Array.isArray(raw) || raw.length < min || raw.length > max) return `manda de ${min} a ${max} pedidos`;
  const out: SuggestedAsk[] = [];
  for (const it of raw as Record<string, unknown>[]) {
    const size = String(it?.size ?? "");
    const title = String(it?.title ?? "").trim().slice(0, 80);
    const ask = String(it?.ask ?? "").trim().replace(/^@plan\s+/i, "").slice(0, 600);
    const why = String(it?.why ?? "").trim().slice(0, 200);
    if (!["chico", "mediano", "grande"].includes(size)) return "size va como chico, mediano o grande";
    if (!title || !why) return "cada pedido lleva title y why";
    if (ask.length < 40) return `el pedido «${title}» es muy corto: escribe el mensaje completo que recibirías`;
    // Con varios repos en el room, cada pedido dice de cuál es (si no, «Pedir» lo manda
    // sin repo y el plan nace sin saber dónde trabajar).
    const repo = String(it?.repo ?? "").trim() || (repos.length === 1 ? repos[0] : "");
    if (repos.length > 1 && !repos.includes(repo)) return `«${title}»: di en \`repo\` de cuál repo es (${repos.join(", ")})`;
    out.push({ size: size as SuggestedAsk["size"], title, ask, why, ...(repo ? { repo } : {}) });
  }
  return out;
}

/** Encabezados de SECCIÓN del plan: nunca son el nombre del pedido (así quedó #1 como «Historia»). */
export const SECTION_HEADING =
  // Encabezado COMPLETO de sección (con variantes conocidas). Nunca por prefijo: «Pruebas
  // vitest para…» es un título real y un prefijo lo tomaba por sección.
  /^(historia( de usuario)?|brief( t[ée]cnico)?|riesgos( y (lo que |qu[ée] )?no se har[áa])?|contexto|resumen|objetivo|criterios( de aceptaci[óo]n)?|alcance|(lo que |qu[ée] )?no se har[áa]|pruebas|plan|c[óo]mo( se prueba)?|problema|pasos|riesgos y fuera de alcance|fuera de alcance|listo cuando)\s*:?\s*$/i;

/** Título de la corrida: el explícito, o el primer encabezado del plan que no sea de sección. */
export function planTitle(title: unknown, planMd: string): string {
  const explicit = String(title ?? "").trim();
  const heading = [...planMd.matchAll(/^#+\s*(.+)$/gm)].map((m) => m[1].trim()).find((h) => !SECTION_HEADING.test(h));
  const t = explicit || heading || planMd.split("\n").find((l) => l.trim() && !/^#/.test(l)) || "";
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
          issue: { type: "number", description: "Número del issue de GitHub que resuelve el pedido (si viene de uno). La plataforma pone `Closes #N` en el PR: no lo escribas tú." },
          requires_preview: {
            type: "boolean",
            description:
              "true si algún criterio sólo se comprueba con la app corriendo (pantallas, formularios, sesión, pagos, una subida mayor de framework). " +
              "Entonces @check no puede aprobar ni se puede mezclar sin la preview lista. false si basta el CI (CLI, librería, docs).",
          },
        },
        required: ["plan_md", "requires_preview"],
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
        // Eval de @plan: el plan va al juez, sin tarjeta ni firma.
        if (run) {
          const E = await import("./factory-evals.server");
          const meta = await E.evalMeta(run.id);
          if (meta) {
            if (meta.config.role !== "plan" || run.status !== "planning") return { ok: false, error: "este eval no espera un plan" };
            await E.evalPlanDone(run, meta, sub, planMd, await origin());
            return { ok: true, runId: run.id, note: "Es un eval: el juez ya tiene tu plan. Tu paso terminó; no esperes firma." };
          }
        }
        // Un plan sólo entra en planeación o en revisión del plan, y se revisa ANTES de escribir
        // nada: desde el hilo de un pedido ya construido, «crear un pedido aparte» caía en ÉSTE,
        // le cambiaba el título y luego `applyEvent` tronaba (MailMask #15 → «Página 404…», 6-oct).
        if (run && run.status !== "planning" && run.status !== "plan_review") {
          return {
            ok: false,
            error:
              `Este hilo es del pedido #${run.id} «${run.title}» (etapa «${stageLabel(run.status)}»): ya no acepta plan y no se tocó. ` +
              `Si es un cambio a ESE PR, usa factory_note; si es algo distinto, pide en el room que se abra un pedido nuevo (fuera de este hilo).`,
          };
        }
        if (!run) {
          // El repo del pedido: con un solo repo en el room es ése; con VARIOS es obligatorio.
          // Sin esto el pedido nacía con repo NULL y la preview, «Listo para agentes» y el
          // cierre al merge no sabían de qué repo era. Se valida antes de publicar nada.
          const dbr = await import("../../db.server");
          const repos = (await dbr.listRoomRepos(dest.channelId)).map((r) => r.repo);
          const asked = a.repo ? String(a.repo).trim() : "";
          if (asked && repos.length && !repos.includes(asked))
            return { ok: false, error: `«${asked}» no está en este room. Repos del room: ${repos.join(", ")}` };
          if (!asked && repos.length > 1)
            return { ok: false, error: `Este room tiene varios repos: di en \`repo\` sobre cuál es el plan (${repos.join(", ")}).` };
          const repo = asked || repos[0] || null;
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
          const rows = await dbq(
            `INSERT INTO gt_factory_runs (channel_id, root_msg_id, topic, title, status, repo, requested_by)
             VALUES (?, ?, ?, ?, 'planning', ?, ?) RETURNING id`,
            [dest.channelId, root, dest.topic || "general", planTitle(a.title, planMd), repo, sub],
          );
          run = (await R.getRun(Number(rows[0].id)))!;
        }
        const issue = Number(a.issue);
        if (Number.isInteger(issue) && issue > 0) await dbq("UPDATE gt_factory_runs SET issue_number = ? WHERE id = ?", [issue, run.id]);
        const version = run.planVersion + 1;
        const firstPlan = run.planVersion === 0;
        // El título sigue al plan vigente: antes se congelaba con la primera versión y viajaba
        // así a @build, @check, la tarjeta y la tarea.
        // Sólo con título EXPLÍCITO: sin él, una v2 le cambiaba el nombre al pedido por su
        // primer encabezado («Historia»).
        const title = String(a.title ?? "").trim() ? planTitle(a.title, planMd) : "";
        // Va en el mismo UPDATE que la transición: si el estado no admite plan, el título no cambia.
        const retitle = !firstPlan && title && title !== run.title ? { title } : {};
        run = await R.applyEvent(run, "plan_submitted", { plan_version: version, ...retitle }, { actor: "plan", data: { version } });
        // Sin `requires_preview` (modelo que no la manda) queda NULL y se deduce de los criterios.
        const requiresPreview = typeof a.requires_preview === "boolean" ? (a.requires_preview ? 1 : 0) : null;
        await dbq("INSERT INTO gt_factory_plans (run_id, version, plan_md, requires_preview) VALUES (?, ?, ?, ?)", [run.id, version, planMd, requiresPreview]);
        const msgId = await R.postInThread(run, "plan", R.planCardFence(run.id, version));
        if (msgId) await dbq("UPDATE gt_factory_plans SET msg_id = ? WHERE run_id = ? AND version = ?", [msgId, run.id, version]);
        // La tarjeta viva en el room (la primera vez) y el aviso de que hay plan nuevo.
        await R.ensureRunCard(run);
        // Crítico del plan: @check lo revisa en otra conversación antes de construir. La persona
        // puede firmar igual; si el crítico pide cambios, vuelve a ti como «cambios: …».
        const critic = await R.startCritique(run, version, await origin()).catch(() => false);
        // Ticket de sprint (sólo él guarda `auto_approve_by`): el sprint ya está aprobado, así que la versión corregida tras el crítico
        // se firma sola con quien lo aprobó (antes esperaba firma humana: el #58 esperó 1.5 h).
        if (!critic) {
          const [auto] = await dbq(
            "SELECT auto_approve_by, auto_approve_who FROM gt_factory_plans WHERE run_id = ? AND auto_approve_by IS NOT NULL ORDER BY version DESC LIMIT 1",
            [run.id],
          ).catch(() => []);
          if (auto?.auto_approve_by) {
            run = await R.decide({ run, version, decision: "approve", sub: String(auto.auto_approve_by), who: String(auto.auto_approve_who ?? "Quien aprobó el sprint"), origin: await origin() });
            return { ok: true, runId: run.id, version, note: `Plan v${version} aprobado solo (ticket de sprint): @build ya lo construye. No construyas tú; di en una línea qué cambió.` };
          }
        }
        void R.refreshRoom(run.channelId);
        return {
          ok: true,
          runId: run.id,
          version,
          note:
            `Tarjeta publicada en el hilo. Ahora espera la firma: no construyas. Di en una línea qué necesita revisar la persona. Si lo nombras, es el «pedido #${run.id}» (nunca «corrida»).` +
            (critic ? " @check ya está revisando el plan; si pide cambios te llegan como encargo." : ""),
        };
      },
    },
    {
      name: "factory_plan_critique",
      description:
        "SÓLO @check cuando te encargan CRITICAR UN PLAN (todavía sin código). pass=true si se puede construir así; " +
        "pass=false con hallazgos concretos para que @plan saque otra versión. No es factory_check_verdict.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "number", description: "El pedido (si no, el del hilo)" },
          version: { type: "number", description: "La versión del plan que revisaste (viene en tu encargo)" },
          pass: { type: "boolean", description: "true = se puede construir así" },
          findings: { type: "string", description: "Hallazgos (obligatorios con pass=false): qué cambiar y por qué, en viñetas" },
        },
        required: ["pass"],
      },
      handler: async (_sub, a) => {
        if (dest?.handle && dest.handle !== "check") return { ok: false, error: "sólo @check critica planes" };
        if (!dest?.channelId) return { ok: false, error: "la fábrica trabaja en un room, no en un DM" };
        const run = await runOf(dest, a.runId);
        if (!run) return { ok: false, error: "no encuentro el pedido: pasa runId" };
        const pass = a.pass === true;
        // Haiku a veces manda una lista: `String()` la pegaba con comas («….,Justificación…», 8-oct).
        const findings = findingsText(a.findings);
        if (!pass && !findings) return { ok: false, error: "con pass=false los hallazgos son obligatorios" };
        const R = await import("./factory-runs.server");
        const version = Number.isInteger(Number(a.version)) && Number(a.version) > 0 ? Number(a.version) : run.planVersion;
        const r = await R.finishCritique(run, pass, findings, await origin(), version);
        return r.ok ? { ...r, note: "Listo. La plataforma ya avisó en el hilo: termina sin repetirlo." } : r;
      },
    },
    {
      name: "factory_git_remote",
      description:
        "SÓLO @build. Remote git para clonar el repo del pedido en tu caja de trabajo y EMPUJAR con `git push` (la forma " +
        "normal de subir tus commits: cualquier tamaño, sin pasar archivos por JSON). La credencial es de esta sesión, " +
        "caduca en 2 h y sólo empuja a la rama del pedido. Llámala otra vez si caducó.",
      inputSchema: {
        type: "object",
        properties: { runId: { type: "number", description: "El pedido (si no, el del hilo)" } },
      },
      handler: async (sub, a) => {
        if (dest?.handle && dest.handle !== "build") return { ok: false, error: "sólo @build empuja código" };
        const run = await runOf(dest, a.runId);
        if (!run) return { ok: false, error: "no encuentro el pedido de este hilo" };
        if (!run.repo) return { ok: false, error: "el pedido no tiene repo" };
        if (run.status === "done" || run.status === "cancelled") return { ok: false, error: `el pedido #${run.id} ya está cerrado` };
        const G = await import("../connectors/github.server");
        const w = await G.gitWriteToken(sub, run.repo);
        if ("error" in w) return { ok: false, error: w.error };
        const base = await origin();
        if (!base) return { ok: false, error: "no pude resolver la dirección de este espacio" };
        const { mintGitSession } = await import("./factory-git.server");
        // PR que ya existía (Dependabot, pedidos viejos): su rama se fija aquí, o el primer push
        // abriría una rama aparte y el PR —con su CI y su preview— se quedaría roto.
        if (!run.branch && run.prUrl) {
          const R = await import("./factory-runs.server");
          const ref = (await R.prHead(sub, run.prUrl).catch(() => null))?.ref ?? null;
          if (ref) {
            const { dbq } = await import("../../dbq.server");
            await dbq("UPDATE gt_factory_runs SET branch = ? WHERE id = ? AND branch IS NULL", [ref, run.id]).catch(() => {});
            run.branch = ref;
          }
        }
        const token = await mintGitSession({ runId: run.id, repo: run.repo, sub, branch: run.branch });
        const host = base.replace(/^https?:\/\//, "");
        const remote = `${base.startsWith("http://") ? "http" : "https"}://x-access-token:${token}@${host}/api/git/${run.id}/${run.repo}.git`;
        const botId = process.env.GITHUB_APP_BOT_USER_ID || "313045761";
        return {
          ok: true,
          remote,
          branch: run.branch,
          expiresInMinutes: 120,
          gitConfig: {
            "user.name": "ghosty-studio[bot]",
            "user.email": `${botId}+ghosty-studio[bot]@users.noreply.github.com`,
          },
          coAuthor: await G.coAuthorOf(sub),
          rules:
            "En tu caja de trabajo: `git clone <remote> repo` (o `git remote set-url origin <remote>` en un clon que ya tengas), " +
            "pon user.name/user.email de gitConfig, termina cada mensaje de commit con una línea en blanco y coAuthor, y " +
            "`git push -u origin <rama>`. Sólo una rama por push y nunca la principal" +
            (run.branch ? ` (este pedido ya empuja a ${run.branch})` : "; la primera rama que empujes queda fija para el pedido") +
            ". Si git contesta 403, el texto dice por qué. Archivos grandes: empújalos con git, nunca con github_push_files.",
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
          pr_url: { type: "string", description: "URL del PR en GitHub (obligatoria, salvo en un eval)" },
          branch: { type: "string", description: "Rama del PR" },
          tests: { type: "string", description: "Resultado de pruebas, lint y typecheck, en una o dos líneas" },
        },
        required: ["tests"],
      },
      handler: async (sub, a) => {
        if (dest?.handle && dest.handle !== "build") return { ok: false, error: "sólo @build cierra la construcción" };
        const R = await import("./factory-runs.server");
        let run = await runOf(dest, a.runId);
        if (!run) return { ok: false, error: "no encuentro el pedido de este hilo" };
        // Un eval no tiene PR: se cierra con la rama y lo califica el juez.
        const E = await import("./factory-evals.server");
        const meta = await E.evalMeta(run.id);
        if (meta) {
          if (meta.config.role !== "build" || run.status !== "building") return { ok: false, error: `este eval no espera construcción (está en ${run.status})` };
          const r = await E.evalBuildDone(run, meta, sub, String(a.tests ?? ""), await origin());
          return "error" in r ? { ok: false, error: r.error } : { ok: true, runId: run.id, note: "El juez ya tiene el eval. Tu paso terminó." };
        }
        const url = String(a.pr_url ?? "");
        if (!R.parsePrUrl(url)) return { ok: false, error: "pr_url tiene que ser la URL de un PR de GitHub" };
        // Sin resultado de pruebas @check revisa a ciegas y la persona no sabe qué corrió (MailMask #10, 4-oct).
        if (String(a.tests ?? "").trim().length < 10)
          return { ok: false, error: "falta el resultado de las pruebas: córrelas (tests, lint, typecheck) y pon en tests qué corrió y cuántas pasaron" };
        // Pedido escalado y una persona despertó a @build en el hilo («reintenta»): eso ES la
        // decisión de otra vuelta. Sin esto @build hacía el trabajo y no podía cerrar su paso.
        if (run.status === "escalated") run = await R.applyEvent(run, "approve");
        // Pedido ya revisado (PR listo) y @build empujó más sobre ESE PR (la persona se lo pidió en
        // el hilo): eso reabre la revisión. Sin esto no podía cerrar su paso, @check no volvía a
        // revisar y la tarjeta del veredicto se quedaba vieja (MailMask #15, 6-oct).
        const samePr = (x: string | null | undefined) => {
          const p1 = R.parsePrUrl(String(x ?? "")), p2 = R.parsePrUrl(url);
          return !!p1 && !!p2 && p1.repo.toLowerCase() === p2.repo.toLowerCase() && p1.number === p2.number;
        };
        if (run.status === "pr_review" && samePr(run.prUrl))
          run = await R.applyEvent(run, "rework", {}, { actor: "build", data: { reason: "commits después del veredicto" } });
        // CI en rojo no llega a @check: se ahorra una vuelta y lo arregla quien construyó.
        const ci = await R.prCi(sub, url);
        if (ci?.state === "failure") {
          // Ciclo acotado (Stripe: máximo 2 rondas de CI): a la 2ª falla seguida, que lo vea
          // una persona en vez de seguir quemando vueltas.
          const { dbq } = await import("../../dbq.server");
          const f = await dbq("UPDATE gt_factory_runs SET ci_fails = COALESCE(ci_fails,0) + 1 WHERE id = ? RETURNING ci_fails", [run.id]);
          if (Number(f[0]?.ci_fails ?? 0) >= 2) {
            await R.postInThread(
              run,
              "build",
              `⚠️ El CI del PR sigue en rojo tras ${f[0].ci_fails} intentos (${ci.failed.join(", ") || "ver checks"}). ` +
                `Necesita una persona: revisa el log o dile a @build qué cambiar. ${url}`,
            );
          }
          return {
            ok: false,
            error: `el CI del PR falló (${ci.failed.join(", ") || "ver checks"}). Lee el log con github_workflow_run_logs, corrígelo en la misma rama y vuelve a cerrar.`,
          };
        }
        // Con choques contra la principal @check lo iba a regresar igual: se ahorra la vuelta.
        if ((await R.prConflicted(sub, url)) === true) {
          return { ok: false, error: `el PR sigue con conflictos contra la rama principal. ${R.MERGE_FROM_HINT} Luego vuelve a cerrar.` };
        }
        // Un PR que toca `.github/` (CI, CODEOWNERS) sólo se espera en el pedido de CI: en
        // cualquier otro, es justo la vía clásica para que un agente se salte los controles.
        const touchesGithub = await R.prTouchesGithubDir(sub, url);
        const head = await R.prHead(sub, url);
        const next = await R.applyEvent(run, "build_done", {
          ci_fails: 0,
          pr_url: url,
          branch: a.branch ? String(a.branch) : run.branch,
          head_sha: head?.sha ?? null,
        }, { actor: "build", data: { pr: url, tests: String(a.tests ?? "").slice(0, 300) } });
        await R.ensurePrClosesIssue(run.id, sub, url);
        const plan = await R.getPlan(run.id, run.planVersion);
        await R.handoff(
          next,
          "check",
          sub,
          "revisar el PR",
          `Revisa el PR ${url} contra el plan APROBADO (v${run.planVersion}). Resultado que reporta @build: ${String(a.tests).slice(0, 500)}\n\n` +
            `## Plan aprobado\n${plan?.planMd ?? "(no encontré el plan)"}\n\n` +
            (next.checkScope
              ? `## Alcance de esta vuelta\n${next.checkScope}\n\nRevisa SÓLO esto. Lo nuevo que encuentres fuera del alcance va como nota ` +
                `(factory_note) o issue aparte, no como pass=false.\n\n`
              : "") +
            (touchesGithub
              ? `⚠️ Este PR modifica archivos de .github/ (CI o CODEOWNERS). Si el pedido NO es agregar o arreglar el CI, es un hallazgo: repórtalo con pass=false` +
                (R.isDependabotUpgrade(run)
                  ? ` (excepción: en una subida de Dependabot se pide agregar un grupo de paquetes hermanos a .github/dependabot.yml; sólo eso, nada de workflows ni CODEOWNERS). `
                  : `. `)
              : "") +
            ((await R.previewRequired(next))
              ? `Este pedido EXIGE la preview: pide la URL con factory_preview (runId ${run.id}), comprueba AHÍ los criterios de aceptación ` +
                `(incluida una acción que envíe datos, no sólo abrir páginas) y cita la URL en tu veredicto. Sin ella lista no puedes aprobar; ` +
                `probar en tu caja no la sustituye. `
              : `Si el repo publica previews, pide la URL con factory_preview (runId ${run.id}): comprueba AHÍ los criterios de ` +
                `aceptación que se ven en pantalla y cita la URL en tu veredicto; si está en camino, espera a que esté lista. `) +
            `Lee el diff con github_pr_files y el CI con github_pr_checks. Si el CI sigue corriendo, usa ` +
            `github_watch_pr y espera el aviso antes de dar tu veredicto (no apruebes con CI pendiente). ` +
            `NO edites ni empujes nada. ` +
            `Cierra con factory_check_verdict (runId ${run.id}).`,
          await origin(),
          "",
          { from: "build" },
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
          findings: { type: "string", description: "Hallazgos (obligatorio si pass=false), en markdown breve: una línea por hallazgo con archivo:línea y qué falta. Texto, no una lista de objetos." },
          blocked: {
            type: "boolean",
            description:
              "true si lo que falta NO lo puede resolver @build con sus herramientas (falta una tool, un permiso o un acceso). " +
              "No se le regresa: pasa directo a una persona. Úsalo en vez de regresar lo mismo varias veces.",
          },
          kind: {
            type: "string",
            enum: ["env", "fix", "skip", "decision"],
            description:
              "Obligatorio con pass=false: qué tiene que pasar para seguir. " +
              "env = faltan variables o credenciales (las da una persona); " +
              "fix = @build lo puede arreglar en la rama (incluye subir los paquetes hermanos de un grupo de Dependabot o un arreglo de tipos de una línea); " +
              "skip = no conviene este cambio o esta subida (cerrar el PR e ignorar la versión); " +
              "decision = una persona tiene que elegir entre caminos. " +
              "Si la preview no arranca o sigue en camino NO escales: espera (la plataforma lo detecta sola). " +
              "Si GitHub limita las peticiones (rate limit, 403/429) no es decision: espera y reintenta; si no se libera, " +
              "pass=false con «GitHub está limitando las peticiones» en findings y la plataforma lo pausa y te lo regresa sola.",
          },
          reason: {
            type: "string",
            description:
              "Obligatorio con pass=false: el motivo en UN renglón de lenguaje llano (≤140 caracteres), sin rutas ni jerga. " +
              "Es lo que lee la persona en el aviso del teléfono (p. ej. «Faltan 5 variables de la preview: DATABASE_URL y 4 más»).",
          },
          risk: {
            type: "string",
            enum: ["low", "high"],
            description:
              "Con pass=true: cuánto cuidado necesita la revisión humana. La plataforma ya lo sube a high si el PR toca " +
              "auth, migraciones, dependencias, API pública, .github/ o es grande; tú puedes subirlo por lógica delicada, nunca bajarlo.",
          },
          summary: {
            type: "string",
            description:
              "Con pass=true: qué cambia para quien usa el producto, en 1 o 2 frases sin jerga ni rutas " +
              "(p. ej. «La CLI ya transfiere dominios y cambia sus DNS; registrations ya no imprime el código EPP»). Es lo primero que lee la persona.",
          },
          tryIt: {
            type: "string",
            description: "Con pass=true: cómo comprobarlo en 1 frase (en la preview: ruta y qué hacer; sin preview: el comando). Omítelo si no hay nada que probar a mano.",
          },
          proof: {
            type: "array",
            maxItems: 4,
            description:
              "Con pass=true: los comandos que CORRISTE en tu caja para comprobarlo, con su resultado real (lo que la persona tendría que correr para creerte). " +
              "Sustituye a tryIt en la tarjeta: la persona ve el resultado, no la receta. Nunca pongas un comando que no corriste; si no corriste nada, omítelo.",
            items: {
              type: "object",
              properties: {
                cmd: { type: "string", description: "El comando tal cual (p. ej. npx tsc -v)" },
                ok: { type: "boolean", description: "true si salió con código 0 y dio lo esperado" },
                result: { type: "string", description: "El resultado en pocas palabras (p. ej. «Version 7.0.2», «0 errores», «42 pruebas pasan»)" },
                output: { type: "string", description: "Las últimas líneas de la salida (máx. ~15), para quien quiera verla" },
              },
              required: ["cmd", "ok", "result"],
            },
          },
          evidencePath: {
            type: "string",
            description: "Con pass=true y preview: la ruta de la pantalla que cambió (p. ej. /agenda). La plataforma la captura en escritorio y móvil para la tarjeta.",
          },
          readFirst: {
            type: "array",
            maxItems: 5,
            description: "Con pass=true: lo que una persona debe leer primero para revisar en 2 minutos (máx. 5), lo más delicado arriba.",
            items: {
              type: "object",
              properties: {
                file: { type: "string" },
                lines: { type: "string", description: "p. ej. 40-72" },
                why: { type: "string", description: "Por qué mirarlo, en una frase" },
              },
              required: ["file"],
            },
          },
        },
        required: ["pass"],
      },
      handler: async (sub, a) => {
        if (dest?.handle && dest.handle !== "check") return { ok: false, error: "sólo @check da el veredicto" };
        const R = await import("./factory-runs.server");
        const run = await runOf(dest, a.runId);
        if (!run) return { ok: false, error: "no encuentro el pedido de este hilo" };
        {
          // Eval de @check: el veredicto del rol evaluado va al juez. El juez califica con factory_eval_score.
          const E = await import("./factory-evals.server");
          const meta = await E.evalMeta(run.id);
          if (meta) {
            if (meta.config.role !== "check" || meta.stepDoneAt) return { ok: false, error: "esto es un eval: califícalo con factory_eval_score, no con un veredicto" };
            const f = String(a.findings ?? "").trim();
            if (a.pass !== true && !f) return { ok: false, error: "con pass=false los hallazgos son obligatorios" };
            await E.evalCheckDone(run, meta, sub, a.pass === true, f, await origin());
            return { ok: true, note: "Es un eval: tu veredicto ya está con el juez. Tu paso terminó." };
          }
        }
        if (run.status === "plan_review")
          return { ok: false, error: "todavía no hay PR: si te encargaron criticar el plan, ciérralo con factory_plan_critique" };
        if (run.status !== "checking") return { ok: false, error: `el pedido no está en revisión (está en ${run.status})` };
        // La regla de @check se cumple aquí, no en su prompt: si la cabeza del PR se movió
        // desde que @build cerró, alguien empujó durante la revisión.
        const head = run.prUrl ? await R.prHead(sub, run.prUrl) : null;
        // Lo que @check revisó; se guarda con cada veredicto para decidir si la próxima vuelta cuenta.
        // El alcance acotado sirve para UNA revisión: se borra con el veredicto.
        const checked = { checked_sha: head?.sha ?? run.checkedSha ?? null, check_scope: null };
        // La cabeza se movió durante la revisión (la plataforma lo puso al día con main, «Correr CI»,
        // o empujó una persona). Unos hallazgos siguen valiendo; aprobar exige mirar lo nuevo: se
        // fija la cabeza nueva y @check revisa sólo ese tramo. Antes se rechazaba siempre y @check
        // se quedaba sin salida (palmera-legal #4, 3-oct).
        if (run.prUrl && run.headSha && head && head.sha !== run.headSha && a.pass === true) {
          const { dbq } = await import("../../dbq.server");
          await dbq("UPDATE gt_factory_runs SET head_sha = ? WHERE id = ?", [head.sha, run.id]);
          await R.logEvent(run.id, "head_moved", "check", { from: run.headSha, to: head.sha });
          return {
            ok: false,
            error:
              `la cabeza del PR cambió durante tu revisión (${run.headSha.slice(0, 7)}→${head.sha.slice(0, 7)}; p. ej. la plataforma lo puso al día con main). ` +
              `Revisa sólo ese cambio (compare ${run.headSha.slice(0, 7)}...${head.sha.slice(0, 7)}) y vuelve a dar tu veredicto.`,
          };
        }
        // El esquema pide texto, pero el modelo a veces manda una LISTA de objetos
        // ({file, line, issue}…): con `String()` le llegaba a @build «[object Object] ×4» y no
        // sabía qué corregir (pedido #10, 01-oct). Se normaliza a markdown legible.
        const findings = findingsText(a.findings);
        // Aprobar exige CI en verde, verificado aquí y no en la palabra del modelo. `none` (el
        // repo no tiene CI) se permite, pero se dice en la tarjeta.
        if (a.pass === true && run.prUrl) {
          const ci = await R.prCi(sub, run.prUrl);
          if (ci?.state === "pending")
            return { ok: false, error: "el CI todavía corre: usa github_watch_pr y da tu veredicto cuando termine." };
          if (ci?.state === "failure")
            return { ok: false, error: `el CI está en rojo (${ci.failed.join(", ") || "ver checks"}): no puede pasar. Repórtalo con pass=false.` };
          // `none` (sin CI) pasa, pero la tarjeta lo dice.
        }
        // Preview exigida (por el plan o por ser un major): sin ella lista en la cabeza no hay pass.
        // «Probado en mi caja» no la sustituye: por http local el CSRF de React Router 8 nunca
        // disparaba y en prod daba 400 a toda acción (#96 de Deník, 16-oct). Como Devin: si no
        // llega a la app, pide ayuda en vez de aprobar.
        const gate = a.pass === true ? await R.previewGate(run, head?.sha ?? null) : null;
        if (gate)
          return {
            ok: false,
            error: gate.waits
              ? `este pedido exige la preview y ${gate.reason}: espera a que esté lista (factory_preview) y pruébala ahí antes de aprobar.`
              : `este pedido exige la preview y ${gate.reason}: no puede pasar. Si es el código del PR, pass=false con el hallazgo; ` +
                `si faltan variables, pass=false con kind=env diciendo cuáles; si es otra cosa que @build no puede dar, kind=decision. Probar en tu caja no la sustituye.`,
          };
        // Con la preview lista, un POST con el Origin real (smoke de acción): lo que el CI y el
        // localhost no ven. Si la rechaza o truena, no hay pass (#96, 16-oct).
        const livePreview = a.pass === true ? await R.runPreview(run.id, { fresh: true }) : null;
        const S = await import("./factory-smoke.server");
        const smoke = livePreview?.state === "ready" && livePreview.url ? await S.runActionSmoke(livePreview.url, run.repo, sub) : null;
        if (S.smokeFailures(smoke))
          return {
            ok: false,
            error:
              `el smoke de la plataforma sobre la preview falló:\n${S.smokeFailures(smoke)}\n` +
              `Es un hallazgo (pass=false): un envío real a la preview (https, con Origin) no pasa. Revisa cambios de CSRF/origen, cookies o proxy en lo que subió.`,
          };
        if (a.pass === true) {
          const next = await R.applyEvent(run, "check_pass", checked, { actor: "check" });
          // Sacarlo de borrador lo hace la plataforma, no el prompt: antes dependía de que
          // @check se acordara de github_mark_ready, y la tarjeta ya decía «listo».
          const ready = run.prUrl ? await R.markPrReady(sub, run.prUrl) : false;
          // El veredicto va como TARJETA (```gt-verdict```): los datos duros (diff, CI) salen de
          // GitHub, no de la palabra del modelo; su texto queda como «Detalle» plegado.
          const pr = run.prUrl ? R.parsePrUrl(run.prUrl) : null;
          const { githubApi } = await import("../connectors/github.server");
          const info = pr ? await githubApi(sub, `/repos/${pr.repo}/pulls/${pr.number}`).catch(() => null) : null;
          const ciState = run.prUrl ? ((await R.prCi(sub, run.prUrl))?.state ?? "none") : "none";
          const { classifyPrRisk, mergeCheckRisk, clipSentence } = await import("./factory-risk");
          const risk = mergeCheckRisk(classifyPrRisk(run.prUrl ? await R.prFiles(sub, run.prUrl) : []), a);
          const verdict = {
            prNumber: pr?.number ?? null,
            files: Number(info?.changed_files ?? 0),
            additions: Number(info?.additions ?? 0),
            deletions: Number(info?.deletions ?? 0),
            ci: ciState,
            ready,
            planVersion: run.planVersion,
            loops: run.loops,
            findings: findings.slice(0, 4000),
            risk: risk.level,
            riskReasons: risk.reasons,
            readFirst: risk.readFirst,
            summary: a.summary ? clipSentence(String(a.summary), 320) : null,
            tryIt: a.tryIt ? clipSentence(String(a.tryIt), 200) : null,
            proof: Array.isArray(a.proof)
              ? a.proof
                  .filter((p: any) => p && typeof p.cmd === "string" && p.cmd.trim())
                  .slice(0, 4)
                  .map((p: any) => ({
                    cmd: String(p.cmd).slice(0, 200),
                    ok: p.ok === true,
                    result: clipSentence(String(p.result ?? ""), 120),
                    output: p.output ? String(p.output).split("\n").slice(-15).join("\n").slice(-1500) : null,
                  }))
              : [],
            // La ruta que pidió @check: si las capturas se rehacen con una preview nueva, salen de ahí.
            evidencePath: a.evidencePath ? String(a.evidencePath) : null,
            // Con qué preview se aprobó (null = no la exigía): la tarjeta lo dice.
            preview: (await R.previewRequired(run)) ? livePreview : null,
            // El POST de la plataforma a la preview (null = no hubo preview o nada que probar).
            smoke,
          };
          const { dbq } = await import("../../dbq.server");
          await dbq("UPDATE gt_factory_runs SET verdict_json = ?, pr_ready_at = unixepoch() WHERE id = ?", [JSON.stringify(verdict), run.id]);
          await R.postInThread(
            next,
            "check",
            // Cierre explícito de la fábrica: quien lee el hilo tiene que saber que ya NADIE está
            // trabajando y que lo que sigue es de una persona (revisar y mezclar). La línea de
            // texto es para avisos y clientes que no pintan la tarjeta.
            "```gt-verdict\n" + JSON.stringify({ runId: run.id }) + "\n```\n" +
              "🏁 La fábrica terminó su parte: el PR espera tu revisión.",
          );
          // Evidencia visual: la preview capturada en escritorio y móvil, en segundo plano.
          void import("./factory-shots.server").then((S) => S.captureVerdictShots(run.id, a.evidencePath ? String(a.evidencePath) : null));
          // El check «Ghosty · Preview» del PR, con lo mismo que acaba de pasar la puerta.
          if (pr && head?.sha) void import("./factory-preview-check.server").then((C) => C.syncPrCheck(pr.repo, pr.number, head.sha));
          return { ok: true, status: next.status, note: "La plataforma ya avisó en el hilo y sacó el PR de borrador. Termina sin repetirlo." };
        }
        if (!findings) return { ok: false, error: "con pass=false los hallazgos son obligatorios" };
        // GitHub limitó las peticiones (#137 de business, 20-oct): no es una decisión ni algo de @build.
        // `platform` lo pone la plataforma aunque @check mande otro kind; sin push, y @check revisa
        // otra vez sola cuando GitHub se libera.
        if (isGithubRateLimit(`${findings}\n${a.reason ?? ""}`)) {
          let resetAt: number | null = null;
          try {
            resetAt = (await import("../connectors/github.server")).githubRateLimitResetAt(sub);
          } catch { /* sin dato: 15 min */ }
          const next = await R.escalateRateLimit(run, { findings, resetAt, extra: checked });
          if (!next) return { ok: false, error: "no pude pausar el pedido por el límite de GitHub" };
          return { ok: true, status: next.status, note: "GitHub limitó las peticiones: la plataforma pausó el pedido y te lo regresa cuando se libere. No lo repitas." };
        }
        // El tipo y el motivo del escalado (easybits, 20-oct): sin ellos la persona veía «Te toca» sin
        // saber qué decidir. `platform` no lo elige @check: lo pone la plataforma.
        if (a.kind === "platform")
          return { ok: false, error: "kind=platform lo pone la plataforma. Si la preview no arranca o sigue en camino, espera y vuelve a pedirla con factory_preview." };
        if (!isEscalationKind(a.kind))
          return { ok: false, error: "con pass=false falta kind: env (faltan variables), fix (@build lo arregla en la rama), skip (no conviene este cambio) o decision (una persona elige)." };
        const reason = clipReason(String(a.reason ?? ""));
        if (!reason) return { ok: false, error: "con pass=false falta reason: el motivo en un renglón llano (≤140), lo que lee la persona en su teléfono." };
        const kind = a.kind;
        // env/skip/decision no los arregla @build: regresárselo sólo gasta una vuelta. Escalan directo.
        const blocked = a.blocked === true || kind !== "fix";
        if (blocked) {
          // Un CI en fila o corriendo no es un bloqueo: se espera. @check escaló el #75 de business
          // (13-oct) por un run «queued» 16 min que luego corrió solo; la persona decidió sobre nada.
          const ci = run.prUrl ? await R.prCi(sub, run.prUrl) : null;
          if (ci?.state === "pending")
            return { ok: false, error: "el CI todavía está en fila o corriendo, y eso no es un bloqueo: usa github_watch_pr y da tu veredicto cuando termine." };
          // Igual con la preview en camino o esperando lugar: cinco PRs de easybits escalaron «la
          // preview no está lista» y la persona decidió sobre nada (20-oct). El pedido sigue en revisión;
          // si no arranca en 15 min la plataforma lo marca sola.
          const pv = await R.runPreview(run.id);
          if (pv.state === "pending" || pv.state === "waiting")
            return {
              ok: false,
              error:
                `la preview ${pv.state === "waiting" ? `espera lugar (${pv.error ?? "sin lugar"})` : "se está construyendo"}, y eso no es un bloqueo: ` +
                "espera y vuelve a pedirla con factory_preview. Si no arranca, la plataforma lo detecta sola y te avisa.",
            };
          const next = await R.applyEvent(run, "check_blocked", checked, { actor: "check", data: { findings: findings.slice(0, 4000), kind, reason } });
          // decision/fix/env: el brief de gs en llano (si contesta a tiempo); si no, lo de siempre.
          await R.postEscalation(next, kind, findings, `⚠️ **${ESCALATION_TITLE[kind]}** — ${reason}\n\n${findings}\n\n${ESCALATION_ASK[kind]}`);
          await R.postRunCard(next);
          return { ok: true, status: next.status, note: "Escalado a una persona. No lo repitas." };
        }
        // Una vuelta cuenta sólo si @build movió el código desde la revisión anterior.
        const counted = countsLoop({ checkedSha: run.checkedSha ?? null, headSha: head?.sha ?? null, prevUncounted: await R.lastFailUncounted(run.id) });
        const next = await R.applyEvent(
          run,
          "check_fail",
          { loops: run.loops + (counted ? 1 : 0), ...checked },
          // Vueltas agotadas: ya no es «@build lo arregla» sino una persona que elige.
          { actor: "check", data: { findings: findings.slice(0, 4000), counted, kind: run.loops + (counted ? 1 : 0) >= MAX_LOOPS ? "decision" : kind, reason } },
        );
        if (next.status === "escalated") {
          await R.postEscalation(
            next,
            "decision",
            findings,
            `⚠️ **Necesita una decisión** — ${next.loops} vueltas entre @build y @check sin cerrar. Lo último que encontré:\n\n${findings}\n\n` +
              "Decide en la tarjeta de abajo: lee los puntos y elige «Que @build lo arregle» o «Rehacer el plan».",
          );
          await R.postRunCard(next);
          return { ok: true, status: next.status };
        }
        await R.handoff(
          next,
          "build",
          // Con las credenciales de quien firmó (la 1ª construcción también): quien pidió
          // puede no tener GitHub.
          next.approvedBy ?? next.requestedBy,
          "corregir hallazgos de @check",
          `@check regresó el PR ${run.prUrl ?? ""} (vuelta ${next.loops} de 3${counted ? "" : "; ésta no contó porque el PR no cambió desde la revisión anterior"}). ` +
            `Corrige en la MISMA rama, EMPUJA los commits y cierra otra vez con factory_build_done (runId ${run.id}).\n\n## Hallazgos\n${findings}` +
            (run.prUrl && (await R.prConflicted(next.approvedBy ?? next.requestedBy, run.prUrl)) === true
              ? `\n\n## El PR tiene conflictos con la rama principal\n${R.MERGE_FROM_HINT}`
              : "") +
            (await R.takeNotes(run.id)),
          await origin(),
          "",
          { from: "check" },
        );
        return { ok: true, status: next.status, note: "Regresado a @build." };
      },
    },
    {
      name: "factory_eval_score",
      description:
        "SÓLO el JUEZ de un eval (🧪): @eval, o @check si el espacio no tiene @eval. Del 1 al 5 en cada criterio de la rúbrica que llegó en tu encargo (las claves " +
        "dependen del rol evaluado) y si lo evaluado es worse, same o better que lo que se hizo de verdad. La plataforma la guarda y cierra el eval.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "number", description: "El eval (si no, el del hilo)" },
          scores: {
            type: "object",
            description:
              "Enteros del 1 al 5 con las claves de la rúbrica del encargo: plan → coverage, concrete, risks, signable; " +
              "build → plan, tests, maintainability, scope; check → catches, precision, actionable, verdict.",
            additionalProperties: { type: "number" },
          },
          vs_original: { type: "string", enum: ["worse", "same", "better"] },
          notes: { type: "string", description: "Por qué, en 2-4 líneas: lo mejor y lo peor frente al original" },
        },
        required: ["scores", "vs_original"],
      },
      handler: async (sub, a) => {
        const run = await runOf(dest, a.runId);
        if (!run) return { ok: false, error: "no encuentro el eval de este hilo" };
        const E = await import("./factory-evals.server");
        const meta = await E.evalMeta(run.id);
        if (!meta) return { ok: false, error: "este pedido no es un eval: usa factory_check_verdict" };
        // Sólo el juez que el eval fijó al nacer: el rol evaluado no se califica a sí mismo.
        const judge = meta.judge ?? "check";
        if (dest?.handle !== judge) return { ok: false, error: `sólo @${judge} califica este eval; tu paso ya terminó` };
        if (run.status !== "checking" || !meta.stepDoneAt || meta.result)
          return { ok: false, error: `el eval no espera calificación todavía (está en ${run.status})` };
        const { parseEvalScore } = await import("./factory-evals");
        const result = parseEvalScore(meta.config.role, a);
        if ("error" in result) return { ok: false, error: result.error };
        await E.evalScored(run, meta, result, sub, judge);
        return { ok: true, note: "Calificación guardada: la tabla ya está en el hilo. Cierra con UNA línea con lo más importante que viste (sin repetir notas ni tabla)." };
      },
    },
    {
      name: "factory_close",
      description:
        "Cierra el pedido de este hilo cuando una PERSONA lo pide o el PR ya tiene merge: outcome=merged (terminada) " +
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
        // Manda GitHub, no la palabra del agente: un PR mezclado es pedido TERMINADO aunque el
        // agente diga «cancelled» (así quedó #3 como cancelado con el PR ya mezclado).
        const merged = run.prUrl ? await R.prIsMerged(run.approvedBy ?? run.requestedBy, run.prUrl) : false;
        if (merged || a.outcome === "merged") {
          const next = await R.applyEvent(run, "merged");
          await R.postInThread(next, "check", R.mergedMessage(run));
          return { ok: true, status: next.status, note: "La plataforma ya avisó en el hilo. No lo repitas." };
        }
        const next = await R.applyEvent(run, "cancel");
        return { ok: true, status: next.status };
      },
    },
    {
      name: "factory_sprint_submit",
      description:
        "SÓLO @plan. Propone un SPRINT para un objetivo: épica + 3 a 8 tickets en orden, cada uno de ≤ ~3 h de agente (size S/M/L), " +
        "con criterios de aceptación VERIFICABLES (pruebas o CI) y dependencias sólo si son reales (`depends_on` con las keys). " +
        "La plataforma publica la tarjeta en borrador; una persona la edita y la aprueba con un clic, y entonces cada ticket se " +
        "construye en orden sin volver a pedir firma. Cada ticket TERMINA EN UN PR: una decisión que le toca a una persona (diseño, dominio, " +
        "hosting) no es ticket; pregúntala en el hilo antes o después del sprint. Para ajustar un borrador (te piden cambios), manda `sprint_id`. " +
        "Si la persona RE-PARTE un sprint ya aprobado, manda `replaces` con su id (al aprobarse el nuevo, el viejo se cancela), y si un ticket sigue " +
        "en un PR que ya existe, pon `continues_pr` en ese ticket (no se abre otro PR: el pedido de ese PR recibe el alcance nuevo). No construyas.",
      inputSchema: {
        type: "object",
        properties: {
          sprint_id: { type: "number", description: "Sólo para rehacer un sprint en borrador" },
          replaces: { type: "number", description: "Id del sprint ACTIVO que éste reemplaza (la persona lo re-partió)" },
          repo: { type: "string", description: 'Repo "dueño/repo" (obligatorio si el room tiene varios)' },
          goal: { type: "string", description: "El objetivo, en una o dos frases" },
          title: { type: "string", description: "Título corto de la épica" },
          items: {
            type: "array",
            minItems: 3,
            maxItems: 8,
            items: {
              type: "object",
              properties: {
                key: { type: "string", description: "Identificador corto: A, B, C…" },
                title: { type: "string" },
                size: { type: "string", enum: ["S", "M", "L"] },
                depends_on: { type: "array", items: { type: "string" }, description: "Keys de los tickets que deben tener merge antes" },
                brief: { type: "string", description: "Qué y cómo, en markdown breve" },
                criteria: { type: "string", description: "Criterios de aceptación verificables (lista markdown)" },
                files: { type: "array", items: { type: "string" }, description: "Archivos principales que toca" },
                continues_pr: { type: "string", description: "Número o URL del PR que este ticket CONTINÚA (misma rama, sin PR nuevo)" },
                issue: { type: "number", description: "Issue de GitHub que resuelve el ticket (si viene de uno). La plataforma pone `Closes #N` en su PR." },
              },
              required: ["key", "title", "size", "criteria"],
            },
          },
        },
        required: ["goal", "title", "items"],
      },
      handler: async (sub, a) => {
        if (dest?.handle && dest.handle !== "plan") return { ok: false, error: "sólo @plan propone sprints" };
        if (!dest?.channelId) return { ok: false, error: "la fábrica trabaja en un room, no en un DM" };
        const S = await import("./sprint.server");
        const items = S.validateSprintItems(a.items);
        if (typeof items === "string") return { ok: false, error: items };
        const goal = String(a.goal ?? "").trim();
        const title = String(a.title ?? "").trim().slice(0, 120);
        if (!goal || !title) return { ok: false, error: "el sprint lleva goal y title" };
        if (title.length < 6) return { ok: false, error: "el título parece de prueba. No pruebes la tool: mándala UNA vez con el sprint real" };
        const db = await import("../../db.server");
        const repos = (await db.listRoomRepos(dest.channelId)).map((r) => r.repo);
        const asked = a.repo ? String(a.repo).trim() : "";
        if (asked && repos.length && !repos.includes(asked)) return { ok: false, error: `«${asked}» no está en este room (${repos.join(", ")})` };
        if (!asked && repos.length > 1) return { ok: false, error: `Este room tiene varios repos: di en \`repo\` de cuál es el sprint (${repos.join(", ")}).` };
        const repo = asked || repos[0] || null;
        // Tickets que continúan un PR existente: se atan al pedido dueño de ese PR.
        for (const raw of a.items as Record<string, unknown>[]) {
          if (raw?.continues_pr == null || raw.continues_pr === "") continue;
          const run = await runOfPr(dest, sub, raw.continues_pr);
          if (!run || run.status === "done" || run.status === "cancelled")
            return { ok: false, error: `el ticket ${raw.key}: no hay un pedido abierto con el PR ${raw.continues_pr} en este room` };
          const it = items.find((i) => i.key === String(raw.key ?? "").trim());
          if (it) it.runId = run.id;
        }
        let replaces: number | null = null;
        if (a.replaces == null || a.replaces === "") {
          // Un sprint encima de otro activo duplicaba tickets (MailMask, 4-oct): o lo reemplaza, o se ajusta el que hay.
          const { dbq } = await import("../../dbq.server");
          const [act] = await dbq("SELECT id, title FROM gt_factory_sprints WHERE channel_id = ? AND repo IS ? AND status = 'active' ORDER BY id DESC LIMIT 1", [dest.channelId, repo]).catch(() => []);
          if (act)
            return {
              ok: false,
              error: `Ya hay un sprint activo (#${act.id} «${act.title}») en este repo. Si éste lo reemplaza, manda replaces: ${act.id}; si sólo faltan tickets, ajústalo en vez de abrir otro.`,
            };
        }
        if (a.replaces != null && a.replaces !== "") {
          const old = await S.getSprint(Number(a.replaces));
          if (!old || old.channelId !== dest.channelId || old.status !== "active")
            return { ok: false, error: `el sprint ${a.replaces} no es un sprint activo de este room` };
          replaces = old.id;
        }
        // Repo no listo para agentes → el primer ticket es prepararlo (como empieza Factory).
        const withPrep = await S.withPrepFirst(sub, repo, items);
        try {
          // Sin `sprint_id` pero con un BORRADOR en este hilo: es una versión nueva de ése, no
          // otro sprint. Antes cada corrección de @plan publicaba otra tarjeta (MailMask, 01-oct).
          let sprintId = a.sprint_id ? Number(a.sprint_id) : undefined;
          const root = threadRoot(dest);
          if (!sprintId && root) {
            const { dbq } = await import("../../dbq.server");
            const [draft] = await dbq(
              "SELECT id FROM gt_factory_sprints WHERE channel_id = ? AND root_msg_id = ? AND status = 'draft' ORDER BY id DESC LIMIT 1",
              [dest.channelId, root],
            ).catch(() => []);
            if (draft) sprintId = Number(draft.id);
          }
          const sprint = await S.submitSprint({
            sprintId,
            channelId: dest.channelId,
            repo,
            goal,
            title,
            items: withPrep,
            createdBy: sub,
            parentId: threadRoot(dest),
            replaces,
          });
          return {
            ok: true,
            sprintId: sprint.id,
            tickets: withPrep.length,
            note:
              (withPrep.length > items.length ? "La plataforma antepuso «Preparar repo»: el repo no está listo para agentes. " : "") +
              "Tarjeta publicada en borrador. Termina con una sola línea: la persona la revisa y la aprueba ahí.",
          };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    {
      name: "factory_suggest",
      description:
        "Propone pedidos nuevos para Plan. @plan: cuando te llaman sin un pedido concreto (o te encargan sugerir), de 2 a 5 " +
        "leídos del repo del room. @build y @check: de 1 a 3, cuando la persona te pide algo fuera del pedido actual " +
        "(«pídeselo», «que lo haga Plan») o encuentras algo que merece su propio pedido; es la ÚNICA forma de pasarle trabajo " +
        "a Plan (una @ a otro rol no le llega). La plataforma publica una tarjeta con un botón «Pedir» por pedido: quien lo " +
        "pulsa se lo manda a Plan tal cual en un hilo nuevo. Cada `ask` es el mensaje completo que recibiría Plan " +
        "(sin «@plan»): concreto, con archivos o funciones por nombre y el límite de alcance. Prefiere agregar " +
        "(pruebas, validaciones, TODOs chicos) sobre borrar; nada que borre datos, archivos de producción o historial. " +
        "Después de llamarla, NO repitas la lista en tu respuesta.",
      inputSchema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            minItems: 1,
            maxItems: 5,
            items: {
              type: "object",
              properties: {
                repo: { type: "string", description: 'Repo "dueño/repo" del pedido (obligatorio si el room tiene varios)' },
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
        const from = dest?.handle || "plan";
        const { FACTORY_HANDLES } = await import("./factory-roles");
        if (!(FACTORY_HANDLES as readonly string[]).includes(from)) return { ok: false, error: "sólo los roles de la fábrica sugieren pedidos" };
        if (!dest?.channelId) return { ok: false, error: "sin room no hay dónde publicar" };
        const db = await import("../../db.server");
        const roomRepos = (await db.listRoomRepos(dest.channelId)).map((r) => r.repo);
        const items = suggestItems(a.items, roomRepos, from);
        if (typeof items === "string") return { ok: false, error: items };
        const ch = await db.getChannelById(dest.channelId);
        if (!ch) return { ok: false, error: "room no encontrado" };
        const { resolvedAgents } = await import("../../agents.server");
        const me = (await resolvedAgents()).find((x) => x.handle === from);
        const body = "```gt-asks\n" + JSON.stringify({ roomSlug: ch.slug, items }) + "\n```";
        const { id } = await db.postAgent(dest.channelId, threadRoot(dest), body, "msg", from, me?.name ?? from, dest.topic || "general", me?.avatar ?? "");
        const bus = await import("../bus.server");
        const { currentNamespace } = await import("../tenant.server");
        const msg = await db.getMessage(id);
        if (msg) bus.publish(bus.ch.room(await currentNamespace(), dest.channelId), { t: "message:new", msg });
        return { ok: true, published: items.length, note: "Tarjeta publicada. Termina con una sola línea (o nada): la lista ya está en la tarjeta." };
      },
    },
    {
      name: "factory_ci_starter",
      description:
        "El CI de un repo, en cualquier momento. SIN CI: devuelve los archivos listos (.github/workflows/ci.yml con " +
        "typecheck/lint/test/build, escaneo de secretos y revisión de dependencias, actions fijadas por SHA; y .github/CODEOWNERS); " +
        "@build los escribe TAL CUAL (la protección de la rama exige esos checks). CON CI: devuelve { path, missing } = el workflow " +
        "que ya corre en los PR y los scripts de package.json que no corre; @build los agrega a ESE workflow, sin crear otro. " +
        "@plan lo propone como pedido «Agregar CI» o «Completar CI».",
      inputSchema: {
        type: "object",
        properties: { repo: { type: "string", description: '"dueño/repo" (si no, el del room)' } },
      },
      handler: async (sub, a) => {
        if (!dest?.channelId) return { ok: false, error: "la fábrica trabaja en un room" };
        const db = await import("../../db.server");
        const repos = (await db.listRoomRepos(dest.channelId)).map((r) => r.repo);
        const repo = a.repo ? String(a.repo) : repos.length === 1 ? repos[0] : "";
        if (!repo || !repos.includes(repo)) return { ok: false, error: "di cuál repo del room" };
        const { getAppConfig } = await import("./installed.server");
        const cfg = await getAppConfig<{ ciLabel?: string }>("factory");
        const { repoReadiness } = await import("./readiness.server");
        const r = await repoReadiness(sub, repo, { fresh: true });
        if ("error" in r) return { ok: false, error: r.error };
        if (r.facts.ciPath)
          return { ok: true, path: r.facts.ciPath, missing: r.facts.ciMissing ?? [], note: r.facts.ciMissing?.length ? "Completa ese workflow con esos scripts." : "El CI ya corre todos los scripts del repo." };
        const { buildCiStarter } = await import("./ci-starter.server");
        return buildCiStarter(sub, repo, cfg?.ciLabel ?? null);
      },
    },
    {
      name: "factory_repo_prep",
      description:
        "Los archivos de «Preparar repo» (pedido armado por la plataforma): SÓLO lo que le falta al repo — CI (.github/workflows/ci.yml), " +
        ".github/CODEOWNERS, .github/dependabot.yml, AGENTS.md y README.md. @build los escribe TAL CUAL con github_write_file en una rama " +
        "y sólo completa los comentarios `<!-- @build: … -->` leyendo el repo.",
      inputSchema: {
        type: "object",
        properties: { repo: { type: "string", description: '"dueño/repo" (si no, el del room)' } },
      },
      handler: async (sub, a) => {
        if (!dest?.channelId) return { ok: false, error: "la fábrica trabaja en un room" };
        const db = await import("../../db.server");
        const repos = (await db.listRoomRepos(dest.channelId)).map((r) => r.repo);
        const repo = a.repo ? String(a.repo) : repos.length === 1 ? repos[0] : "";
        if (!repo || !repos.includes(repo)) return { ok: false, error: "di cuál repo del room" };
        const { getAppConfig } = await import("./installed.server");
        const cfg = await getAppConfig<{ ciLabel?: string }>("factory");
        const { repoReadiness, preparationFiles } = await import("./readiness.server");
        const r = await repoReadiness(sub, repo, { fresh: true });
        if ("error" in r) return { ok: false, error: r.error };
        const out = await preparationFiles(sub, r, cfg?.ciLabel ?? null);
        if ("error" in out) return { ok: false, error: out.error };
        // CI propio incompleto: no hay archivo nuevo, se completa el suyo con estos scripts.
        const ciToComplete = r.facts.ciPath && r.facts.ciMissing?.length ? { path: r.facts.ciPath, missing: r.facts.ciMissing } : undefined;
        return { ok: true, repo, ...out, ...(ciToComplete ? { ciToComplete } : {}) };
      },
    },
    {
      name: "factory_preview",
      description:
        "La preview del PR del pedido: state ready|pending|failed|none, su URL y, si falló, por qué. " +
        "Si el hosting del repo no las publica, la plataforma la construye en una caja propia. Úsala para probar el cambio como lo verá la persona antes del merge.",
      inputSchema: { type: "object", properties: { runId: { type: "number" } } },
      handler: async (sub, a) => {
        const run = await runOf(dest, a.runId);
        // Sin pedido pero en el hilo de un PR (uno de una persona, p. ej. el aviso «PR #44
        // abierto»): la MISMA preview oficial de gs, con las variables del repo y PREVIEW_HOST.
        // Antes @check levantaba la app a mano en su caja, sin variables, y daba el 404 de la
        // app (2026-10-01).
        if (!run) {
          const root = threadRoot(dest);
          const db = await import("../../db.server");
          const rootMsg = root ? await db.getMessage(root).catch(() => null) : null;
          const { prOfMessage } = await import("../../lib/ebdoc");
          const pr = rootMsg?.body ? prOfMessage(rootMsg.body) : null;
          if (!pr) return { ok: false, error: "no hay pedido ni PR en este hilo" };
          const R0 = await import("./factory-runs.server");
          if (await R0.repoPreviewOff(pr.repo))
            return { ok: true, state: "off", note: "El dueño apagó la preview de este repo: revisa con el diff y las pruebas, sin mencionarla." };
          const P = await import("./preview.server");
          const head = await R0.prHead(sub, `https://github.com/${pr.repo}/pull/${pr.number}`);
          if (!head) return { ok: false, error: "no pude leer el PR en GitHub (¿tu GitHub está conectado?)" };
          let b = (await P.gsPreview("status", { repo: pr.repo, pr: pr.number }).catch(() => null))?.status;
          if (!b || b.sha !== head.sha || b.phase === "failed") b = await P.gsPreview("up", { repo: pr.repo, pr: pr.number, sha: head.sha });
          const state = !b ? "pending" : b.phase === "ready" ? "ready" : b.phase === "failed" ? "failed" : "pending";
          return {
            ok: true,
            state,
            url: state === "ready" ? b.url : null,
            error: state === "failed" ? b.error : null,
            note:
              state === "ready"
                ? "Ábrela y prueba ahí el cambio."
                : state === "failed"
                  ? "La preview no arrancó (el motivo va en error). Si faltan variables de entorno, dile al dueño que las guarde en /factory."
                  : "Se está construyendo: vuelve a preguntar en un minuto. No levantes la app tú en una caja.",
          };
        }
        if (!run.prUrl) return { ok: true, state: "none", note: "el pedido todavía no tiene PR" };
        const R = await import("./factory-runs.server");
        // Soltada (su caja se fue sin commit nuevo): pedirla aquí ES la acción explícita que la
        // vuelve a construir; el tick ya no la levanta solo (25-oct).
        if ((await R.runPreview(run.id)).state === "released") await R.retryPreviews({ runId: run.id, force: true });
        // `fresh`: tras un push la fila sigue «lista» con la caja vieja; @check revisaba la anterior.
        const p = await R.runPreview(run.id, { fresh: true });
        const required = await R.previewRequired(run);
        const note =
          p.state === "ready"
            ? "Ábrela y prueba ahí los criterios de aceptación visibles."
            : p.state === "pending"
              ? "Se está publicando: vuelve a preguntar en un minuto. No escales por esto: si no arranca en 15 min, la plataforma lo detecta sola."
              : p.state === "waiting"
                ? `Espera lugar para levantarse (${p.error ?? "sin lugar"}): arranca sola. Vuelve a preguntar en unos minutos; no escales por esto.`
              : p.state === "off"
                ? "El dueño apagó la preview de este repo: revisa con el diff y las pruebas, sin mencionarla."
              : required && (p.state === "needs_env" || p.state === "failed")
                ? `Este pedido EXIGE la preview y ${p.state === "needs_env" ? "espera las variables del repo" : "no arrancó (el motivo va en error)"}: no puedes aprobar. ` +
                  "Si es el código del PR, pass=false con kind=fix y el hallazgo; si faltan variables, pass=false con kind=env diciendo cuáles. Probar en tu caja no la sustituye."
              : p.state === "needs_env"
                ? "La preview espera que el dueño guarde sus variables: revisa con el diff y las pruebas."
                : p.state === "failed"
                ? "La preview no arrancó (el motivo va en error). Si es el código del PR, es un hallazgo; si faltan variables de entorno, dilo y sigue con el diff y las pruebas."
                : required
                  ? "Todavía no hay preview de este PR y el pedido la exige: vuelve a preguntar en un minuto; no apruebes sin ella."
                  : "Todavía no hay preview de este PR: vuelve a preguntar en un minuto o revisa con el diff y las pruebas.";
        // Variables de producción en la preview: lo que @check escriba o cobre ahí será real.
        const prodRisks = run.repo && p.state !== "off" ? await previewEnvRisks(run.repo).catch(() => []) : [];
        const { envRisksText } = await import("./factory-preview-gate");
        const prodNote = prodRisks.length
          ? ` ⚠ Esta preview usa PRODUCCIÓN (${envRisksText(prodRisks)}).` +
            (prodRisks.some((x) => x.risk === "remote_db") ? " No hagas pruebas que escriban (crear, editar, borrar): pruébalo leyendo y decláralo como riesgo." : "") +
            (prodRisks.some((x) => x.risk === "live_payment_key") ? " No completes pagos." : "") +
            (prodRisks.some((x) => x.risk === "real_email") ? " No dispares envíos de correo a direcciones reales." : "")
          : "";
        return { ok: true, ...p, required, ...(prodRisks.length ? { prodRisks } : {}), note: note + prodNote };
      },
    },
    {
      name: "factory_note",
      description:
        "Cualquier rol. Registra una NOTA en un pedido de la fábrica para que llegue a @build: " +
        "un cambio que pidió una persona («faltan los docs del CLI», «mete lo que falta en este PR») o algo que viste revisando su PR desde OTRO hilo. " +
        "Un comentario en GitHub o en otro hilo NO le llega a @build; esto sí. Si el pedido ya tiene su PR listo (esperando merge), " +
        "la nota lo REABRE y @build trabaja en la MISMA rama de inmediato. Identifica el pedido con `pr` (número o URL del PR de GitHub) " +
        "o con `runId` (el #N del PEDIDO en su tarjeta, que NO es el número del PR); si este hilo es el del pedido o el de su PR, sale solo.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "number", description: "Id del PEDIDO (el #N de la tarjeta de la fábrica). NO es el número del PR: para eso usa `pr`." },
          pr: { type: "string", description: "El PR de GitHub del pedido: número («8») o URL. Úsalo cuando la persona habla del PR." },
          text: { type: "string", description: "La nota, breve y accionable (qué falta y dónde)" },
          absorbs: {
            type: "array",
            items: { type: "string" },
            description: "Claves de tickets PENDIENTES del mismo sprint («B», «C»…) que la persona pidió meter en este PR en vez de abrirlos aparte",
          },
        },
        required: ["text"],
      },
      handler: async (sub, a) => {
        const text = String(a.text ?? "").trim().slice(0, 2000);
        if (!text) return { ok: false, error: "la nota está vacía" };
        const run = await resolveNoteRun(dest, sub, a.runId, a.pr);
        if (!run)
          return {
            ok: false,
            error: a.pr
              ? `no encuentro un pedido de la fábrica con el PR ${a.pr} en los repos de este room`
              : "no encuentro un pedido de la fábrica para esta nota: este hilo no es de un pedido ni de su PR. Pasa `pr` (el número del PR) o `runId` (el #N del pedido).",
          };
        if (run.status === "done" || run.status === "cancelled")
          return { ok: false, error: `el pedido #${run.id} ya terminó (${run.status}): pide uno nuevo con @plan` };
        const R = await import("./factory-runs.server");
        const by = dest?.handle ? `@${dest.handle}` : sub;
        const noteId = await R.addNote(run.id, by, text);
        // Tickets del sprint que la persona quiere en ESTE PR: quedan atados al pedido.
        const keys = Array.isArray(a.absorbs) ? a.absorbs.map((k) => String(k).trim()).filter(Boolean).slice(0, 20) : [];
        const S = await import("./sprint.server");
        const absorbed = keys.length ? await S.absorbItems(run.id, keys).catch(() => []) : [];
        // En el hilo del pedido, con liga al hilo de origen si viene de otro.
        const root = threadRoot(dest);
        const elsewhere = !(dest?.channelId === run.channelId && root === run.rootMsgId);
        let from = "";
        if (elsewhere && dest?.channelId && root) {
          const db = await import("../../db.server");
          const ch = await db.getChannelById(dest.channelId).catch(() => null);
          if (ch) from = ` ([hilo](/c/${ch.slug}?thread=${root}))`;
        }
        const extra = absorbed.length ? `\nEntran a este PR: ${absorbed.map((t) => `${t.key} «${t.title}»`).join(", ")}.` : "";
        await R.postInThread(run, dest?.handle ?? "plan", `📝 Nota de ${by}${elsewhere ? ` desde otro hilo${from}` : ""}: ${text}${extra}`);
        // PR listo esperando merge: nadie más le iba a mandar la nota a @build (sólo se leen al
        // encargar), así que se reabre y se le encarga ya, en la misma rama (MailMask, 4-oct).
        if (run.status === "pr_review") {
          const extra = absorbed.map((t) => `\n\n## Ticket ${t.key}: ${t.title}\n${t.bodyMd}`).join("");
          const next = await R.reopenWithNotes(run, by, extra, await origin(), { absorbs: absorbed.map((t) => t.key) });
          if (!next) return { ok: true, runId: run.id, absorbed: absorbed.map((t) => t.key), note: "Guardada, pero el pedido cambió de etapa mientras tanto: @build la recibe en su siguiente encargo." };
          return { ok: true, runId: run.id, status: next.status, absorbed: absorbed.map((t) => t.key), note: `Reabrí el pedido #${run.id}: @build ya está trabajando en la misma rama del PR.` };
        }
        // @build a media obra: la nota entra YA a su turno; si no hay turno vivo, va en el siguiente encargo.
        if (run.status === "building" && (await R.steerRole(run, "build", `Nota de ${by} sobre este pedido (le gana a lo anterior si choca): ${text}${extra}`))) {
          if (noteId) await R.consumeNote(noteId);
          return { ok: true, runId: run.id, absorbed: absorbed.map((t) => t.key), note: "@build ya la recibió en vivo, en su turno en curso." };
        }
        return {
          ok: true,
          runId: run.id,
          absorbed: absorbed.map((t) => t.key),
          note: run.status === "building" || run.status === "checking"
            ? "Guardada: @build la recibe en su siguiente encargo (la próxima vuelta)."
            : "Guardada: @build la recibe en su siguiente encargo.",
        };
      },
    },
    {
      name: "factory_message",
      description:
        "Sólo @build y @check, dentro de su pedido. Escríbele al otro rol una pregunta o un aviso corto " +
        "(«¿el endpoint nuevo devuelve 404 o 200 vacío?», «ya empujé el arreglo del test»). Si está trabajando le entra en vivo; " +
        "si no, lo despierta en su conversación del pedido y te contesta con esta misma tool. En el hilo sólo se ve que se hablaron, no el texto. " +
        "Pregunta en vez de reprobar por una duda; NO sirve para cerrar tu paso (eso sigue siendo factory_build_done / factory_check_verdict). " +
        "Después de preguntar sigue con lo demás: la respuesta te entra en vivo. Máximo 6 mensajes por pedido en cada sentido.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", enum: ["build", "check"], description: "El otro rol" },
          text: { type: "string", description: "El mensaje, breve y concreto" },
          runId: { type: "number", description: "Id del PEDIDO; si este hilo es el del pedido, sale solo" },
        },
        required: ["to", "text"],
      },
      handler: async (sub, a) => {
        const from = dest?.handle;
        if (from !== "build" && from !== "check") return { ok: false, error: "sólo @build y @check se escriben con factory_message" };
        const to = String(a.to ?? "");
        if ((to !== "build" && to !== "check") || to === from) return { ok: false, error: `to tiene que ser «${from === "build" ? "check" : "build"}»` };
        const text = String(a.text ?? "").trim().slice(0, 2000);
        if (!text) return { ok: false, error: "el mensaje está vacío" };
        const run = await resolveNoteRun(dest, sub, a.runId);
        if (!run) return { ok: false, error: "no encuentro el pedido de este hilo: pasa runId" };
        if (run.status === "done" || run.status === "cancelled") return { ok: false, error: `el pedido #${run.id} ya terminó` };
        const R = await import("./factory-runs.server");
        const { dbq } = await import("../../dbq.server");
        const sent = await dbq("SELECT COUNT(*) AS n FROM gt_factory_events WHERE run_id = ? AND type = 'role_msg' AND actor = ?", [run.id, from]).catch(() => []);
        if (Number(sent[0]?.n ?? 0) >= MAX_ROLE_MESSAGES)
          return { ok: false, error: `ya van ${MAX_ROLE_MESSAGES} mensajes a @${to} en este pedido: decide con lo que tienes o pregúntale a la persona en el hilo` };
        await R.logEvent(run.id, "role_msg", from, { to });
        R.postRelay(run, { from, to, kind: "message" });
        const body = `Mensaje de @${from} sobre el pedido #${run.id}: ${text}\n\nSi hace falta contestar, usa factory_message {to: "${from}"}; no lo escribas en el hilo.`;
        if (await R.steerRole(run, to, body)) return { ok: true, delivered: "live", note: `@${to} ya lo recibió en su turno en curso.` };
        const ok = await R.handoff(run, to, run.approvedBy ?? run.requestedBy, `mensaje de @${from}`, body, await origin(), "", { keySuffix: ":msg", skills: false });
        return ok
          ? { ok: true, delivered: "woken", note: `@${to} no estaba trabajando: lo desperté y su respuesta te entra como mensaje.` }
          : { ok: false, error: `no pude despertar a @${to}` };
      },
    },
    {
      name: "factory_help",
      description:
        "Sólo @build (Worker). Si llevas 2 o 3 intentos sin avanzar en lo mismo (el error no cambia, no entiendes por qué falla), " +
        "pide consejo a Arqui: con su modelo fuerte lee el repo y la caja y te devuelve diagnóstico y siguiente paso; te llega en vivo. " +
        "Él NO edita: tú sigues construyendo. Úsala antes de repetir otra vez lo mismo, no para dudas del plan (eso va a la persona en el hilo). " +
        `Máximo 2 por pedido (contando los que pide la plataforma cuando te ve atorado).`,
      inputSchema: {
        type: "object",
        properties: {
          what: { type: "string", description: "Qué falla, con el error exacto" },
          tried: { type: "string", description: "Qué intentaste y qué pasó en cada intento" },
          runId: { type: "number", description: "Id del PEDIDO; si este hilo es el del pedido, sale solo" },
        },
        required: ["what", "tried"],
      },
      handler: async (sub, a) => {
        if (dest?.handle !== "build") return { ok: false, error: "sólo Worker (@build) pide consejo con factory_help" };
        const what = String(a.what ?? "").trim();
        if (what.length < 15) return { ok: false, error: "di qué falla, con el error exacto" };
        const run = await resolveNoteRun(dest, sub, a.runId);
        if (!run) return { ok: false, error: "no encuentro el pedido de este hilo: pasa runId" };
        const R = await import("./factory-runs.server");
        const r = await R.requestAdvice(run, { by: "worker", what, tried: String(a.tried ?? "") });
        return r.ok
          ? { ok: true, note: "Arqui ya está revisando. Su consejo te entra en vivo: mientras, no repitas lo mismo; avanza con otra parte o espera." }
          : r;
      },
    },
    {
      name: "factory_status",
      description:
        "Estado del pedido de este hilo, de runId (el #N del PEDIDO) o de pr (número o URL del PR de GitHub): etapa, versión del plan, vueltas, PR y tarea.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "number", description: "Id del PEDIDO, no el número del PR" },
          pr: { type: "string", description: "Número o URL del PR de GitHub" },
        },
      },
      handler: async (sub, a) => {
        const run = a.pr != null && a.pr !== "" ? await runOfPr(dest, sub, a.pr) : await runOf(dest, a.runId);
        if (!run) return { ok: false, error: "no hay pedido en este hilo" };
        const { stageLabel } = await import("./factory-flow");
        return { ok: true, ...run, stage: stageLabel(run.status) };
      },
    },
    {
      name: "factory_card",
      description:
        "Baja la tarjeta viva del pedido al final de su hilo (y del room); la anterior queda como huella sin botones. " +
        "Úsala cuando la persona no encuentra la tarjeta o pregunta dónde va el pedido. Sin argumentos: el pedido de este hilo.",
      inputSchema: {
        type: "object",
        properties: { runId: { type: "number", description: "Id del PEDIDO, no el número del PR" } },
      },
      handler: async (sub, a) => {
        const run = a.runId != null ? await resolveNoteRun(dest, sub, a.runId) : await runOf(dest, undefined);
        if (!run) return { ok: false, error: "no hay pedido en este hilo: pasa runId" };
        const R = await import("./factory-runs.server");
        const id = await R.ensureRunCard(run, { force: true });
        return id ? { ok: true, note: "La tarjeta ya está abajo. No la vuelvas a pegar en tu respuesta." } : { ok: false, error: "no pude publicar la tarjeta" };
      },
    },
    {
      name: "factory_context",
      description:
        "Lectura. Un pedido A DETALLE: plan vigente completo, notas pendientes para @build, últimos 20 eventos de su bitácora, " +
        "veredicto de @check, ticket/sprint y preview. Sin argumentos: el pedido de este hilo (o el del PR que el hilo menciona). " +
        "Úsala antes de decidir sobre un pedido si la foto del turno no te alcanza.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "number", description: "Id del PEDIDO, no el número del PR" },
          pr: { type: "string", description: "Número o URL del PR de GitHub" },
        },
      },
      handler: async (sub, a) => {
        const run =
          a.pr != null && a.pr !== ""
            ? await runOfPr(dest, sub, a.pr)
            : a.runId != null
              ? await resolveNoteRun(dest, sub, a.runId)
              : ((await runOf(dest, undefined)) ?? (await runsMentionedInThread(dest, sub))[0] ?? null);
        if (!run) return { ok: false, error: "no encuentro ese pedido en los rooms que ves. Pasa `pr` (número del PR) o `runId` (el #N del pedido), o usa factory_room para listarlos." };
        const { runDigest } = await import("./factory-digest.server");
        return { ok: true, runId: run.id, context: await runDigest(run, { detail: true }) };
      },
    },
    {
      name: "factory_run_review",
      description:
        "Sólo @plan y @check. Lectura. El POSTMORTEM de un pedido (el mismo análisis de `ghosty factory runs why`): si fue sano, " +
        "categoría (p. ej. approved_unmet_criterion = se aprobó sin cumplir un criterio del plan), criterios incumplidos, el paso crítico con " +
        "evidencia, señales (atascos, vueltas, CI rojo) y acciones sugeridas. Úsala ante «¿qué pasó con el #N?», un pedido que salió mal o una alerta. " +
        "Sin argumentos: el pedido de este hilo. `refresh: true` lo rehace (tras un deploy o algo nuevo en la bitácora).",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "number", description: "Id del PEDIDO, no el número del PR" },
          pr: { type: "string", description: "Número o URL del PR de GitHub" },
          refresh: { type: "boolean", description: "Rehacer el análisis en vez de leer el guardado" },
        },
      },
      handler: async (sub, a) => {
        const role = dest?.handle ?? "";
        if (role !== "plan" && role !== "check") return { ok: false, error: "sólo @plan y @check revisan pedidos pasados" };
        const run =
          a.pr != null && a.pr !== ""
            ? await runOfPr(dest, sub, a.pr)
            : a.runId != null
              ? await resolveNoteRun(dest, sub, a.runId)
              : ((await runOf(dest, undefined)) ?? (await runsMentionedInThread(dest, sub))[0] ?? null);
        if (!run) return { ok: false, error: "no encuentro ese pedido en los rooms que ves. Pasa `runId` (el #N del pedido) o `pr`, o usa factory_room para listarlos." };
        const R = await import("./factory-runs.server");
        const j = await R.fetchRunWhy(run.id, { full: true, refresh: a.refresh === true });
        if (!j) return { ok: false, error: "el análisis no está disponible ahora (gs no contestó); vuelve a intentarlo en un minuto" };
        const { stageLabel } = await import("./factory-flow");
        return {
          ok: true,
          runId: run.id,
          title: run.title,
          stage: stageLabel(run.status),
          healthy: j.healthy,
          category: j.category,
          ...(j.incomplete?.length ? { incomplete: j.incomplete, warning: "faltan turnos de esos roles: el análisis no es confiable" } : {}),
          ...(j.why ?? {}),
          note: j.healthy
            ? "Pedido sano: no hay barandal que proponer."
            : "Di en 2-3 líneas qué pasó y propón con factory_suggest los barandales que lo habrían frenado (setup del repo, reglas de @check, CI, ficha en docs/agents/). Habla del proceso, nunca de personas.",
        };
      },
    },
    {
      name: "factory_room",
      description:
        "Lectura. Todo lo de la fábrica en este room: pedidos abiertos y los cerrados de los últimos 7 días (etapa, PR, última actividad) " +
        "y sprints activos o en borrador con su avance. Úsala para ubicar el pedido correcto antes de anotar, re-partir o proponer un sprint.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        if (!dest?.channelId) return { ok: false, error: "la fábrica trabaja en un room, no en un DM" };
        const { roomIndex } = await import("./factory-digest.server");
        return { ok: true, room: await roomIndex(dest.channelId, { closedDays: 7 }) };
      },
    },
  ];
}

/** Hallazgos de @check como markdown, vengan como texto, lista u objeto. */
export function findingsText(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw.trim();
  const uno = (x: unknown): string => {
    if (x == null) return "";
    if (typeof x === "string") return x.trim();
    if (typeof x !== "object") return String(x);
    const o = x as Record<string, unknown>;
    const lugar = [o.file ?? o.path, o.line ?? o.lines].filter((v) => v != null && v !== "").join(":");
    const texto = [o.issue, o.message, o.text, o.finding, o.description, o.problem, o.detail, o.title].find((v) => typeof v === "string" && v.trim());
    const arreglo = [o.fix, o.suggestion, o.expected].find((v) => typeof v === "string" && v.trim());
    if (!texto && !lugar) return JSON.stringify(o);
    return `${lugar ? `\`${lugar}\` — ` : ""}${texto ?? JSON.stringify(o)}${arreglo ? ` (arreglo: ${arreglo})` : ""}`;
  };
  if (Array.isArray(raw)) return raw.map(uno).filter(Boolean).map((t) => `- ${t}`).join("\n");
  return uno(raw);
}

/** ¿Este turno de @check es el del crítico del plan? Pedido del hilo en `plan_review` con su
 *  versión vigente pendiente de crítica. */
/** Las variables de la preview que gs marcó como producción (nombre + etiqueta, nunca el valor). */
async function previewEnvRisks(repo: string): Promise<EnvRiskEntry[]> {
  const P = await import("./preview.server");
  const r = await P.gsPreview("env-keys", { repo }).catch(() => null);
  return Array.isArray(r?.risks) ? (r.risks as EnvRiskEntry[]) : [];
}

/** El aviso de producción para @check (crítico y revisor). null = nada que avisar. */
async function previewRiskLine(repo: string): Promise<string | null> {
  const R = await import("./factory-runs.server");
  if (await R.repoPreviewOff(repo)) return null;
  const { envRiskLine } = await import("./factory-preview-gate");
  return envRiskLine(repo, await previewEnvRisks(repo));
}

/** La viabilidad de la preview del repo para el turno de @plan (con el GitHub de quien conectó el repo). */
async function planPreviewLine(dest: ToolDest | null, repo: string): Promise<string | null> {
  if (!dest?.channelId) return null;
  const db = await import("../../db.server");
  const row = (await db.listRoomRepos(dest.channelId)).find((r) => r.repo.toLowerCase() === repo.toLowerCase());
  if (!row?.connectedBy) return null;
  const { repoReadiness } = await import("./readiness.server");
  const r = await repoReadiness(row.connectedBy, repo);
  if ("error" in r) return null;
  const R = await import("./factory-runs.server");
  const { previewViabilityLine } = await import("./factory-preview-gate");
  return previewViabilityLine(repo, {
    off: await R.repoPreviewOff(repo),
    hosting: r.facts.previewHosting,
    runnable: r.facts.previewRunnable,
    envExampleKeys: r.facts.envExampleKeys,
    envSavedKeys: r.facts.envSavedKeys,
    envRisks: r.facts.envRisks,
  });
}

export async function isCriticTurn(dest: ToolDest | null): Promise<boolean> {
  const root = threadRoot(dest);
  if (!dest?.channelId || !root) return false;
  const R = await import("./factory-runs.server");
  const run = await R.runOfThread(dest.channelId, root);
  if (!run || run.status !== "plan_review") return false;
  const plan = await R.getPlan(run.id, run.planVersion);
  return plan?.critique === "pending";
}

/** Las convenciones del repo (`.ghosty/factory.md`) tal como las ve un rol: las comparten los
 *  turnos de pedido y los de mantenimiento programado. */
function repoConventionLines(repo: string, h: string | null, notes: string | null | undefined, roleNotes: string | null | undefined): string[] {
  const out: string[] = [];
  if (notes) out.push(`Convenciones del repo ${repo} (.ghosty/factory.md, las escribió el equipo; le ganan a lo general): ${notes}`);
  if (roleNotes && h) out.push(`Reglas de @${h} en ${repo} (sección «## @${h}» de .ghosty/factory.md; le ganan a lo general): ${roleNotes}`);
  return out;
}

/**
 * Severidad mínima de la revisión suelta de @check sobre un PR sin pedido: `review_severity:` de
 * `.ghosty/factory.md` (lo escribió el equipo en el repo) o, si no, la del ajuste de pr_review del
 * room. null = nadie la fijó y la revisión sigue como siempre (aprueba o bloquea).
 */
export async function looseReviewSeverity(channelId: number, repo: string): Promise<Severity | null> {
  const db = await import("../../db.server");
  const link = (await db.listRoomRepos(channelId).catch(() => [])).find((r) => r.repo.toLowerCase() === repo.toLowerCase());
  if (!link) return null;
  const { repoTeamFile } = await import("./factory-team.server");
  const file = await repoTeamFile(link.repo, link.connectedBy).catch(() => null);
  if (file?.reviewSeverity) return file.reviewSeverity;
  const { automationSettings } = await import("../automations/store.server");
  const settings = await automationSettings(channelId, link.repo, "pr_review").catch(() => ({}) as Record<string, unknown>);
  return parseSeverity(settings.minSeverity);
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
  if (dest?.factoryMode === "advisor") {
    const { ADVISOR_ROLE } = await import("./factory-roles");
    parts.push("En ESTE turno no actúas como ningún rol del pedido: eres Arqui asesorando a Worker; tu identidad de siempre se queda.");
    parts.push(ADVISOR_ROLE);
    return parts.join("\n\n") + "]";
  }
  // Turno de una automatización de GitHub del room (`automations/`): no hay pedido, así que nada de
  // las instrucciones del rol (plan, veredicto, factory_build_done); sí las convenciones del repo.
  if (dest?.factoryMode === "automation" || dest?.automation) {
    const what = dest.automation === "maintenance" ? "el mantenimiento programado del repo" : `una automatización de GitHub de este room${dest.automation ? ` (${dest.automation})` : ""}`;
    parts.push(
      `En ESTE turno trabajas para ${what}, no para un pedido de la fábrica: ` +
        "no hay plan, ni veredicto, ni factory_build_done/factory_check_verdict. Haz el encargo y cuéntalo en este hilo con la liga a GitHub.",
    );
    const role = (h && (FACTORY_HANDLES as readonly string[]).includes(h) ? h : null) as (typeof FACTORY_HANDLES)[number] | null;
    // El repo: el que trae el turno o el del hilo (`gt_factory_thread_overrides`, lo escribe `ctx.wake`).
    const ft = role ? await (await import("./factory-team.server")).factoryTurnFor(role, dest, "").catch(() => null) : null;
    const repo = dest.automationRepo ?? ft?.repo ?? null;
    if (repo && dest.channelId) {
      const db = await import("../../db.server");
      const link = (await db.listRoomRepos(dest.channelId).catch(() => [])).find((r) => r.repo.toLowerCase() === repo.toLowerCase());
      const { repoTeamFile, repoKnowledge } = await import("./factory-team.server");
      const file = link ? await repoTeamFile(link.repo, link.connectedBy).catch(() => null) : null;
      if (file) parts.push(...repoConventionLines(repo, role, file.notes, role ? file.roleNotes[role] : null));
      const { setupLine, knowledgeLine } = await import("./factory-team");
      if (file?.setup && (role === "build" || role === "check")) parts.push(setupLine(repo, file.setup));
      if (link) parts.push(knowledgeLine(repo, await repoKnowledge(repo, link.connectedBy).catch(() => [])));
    }
    return parts.join("\n\n") + "]";
  }
  if (dest?.handle === "eval") {
    const { JUDGE_INSTRUCTIONS } = await import("./factory-roles");
    parts.push("En ESTE turno actúas como @eval; tu identidad de siempre se queda, pero aplica este rol.");
    parts.push(JUDGE_INSTRUCTIONS);
  }
  if (h && (FACTORY_HANDLES as readonly string[]).includes(h)) {
    // @check con el pedido esperando firma y su plan pendiente de crítica = es el CRÍTICO DEL
    // PLAN, no el revisor del PR: sus instrucciones de PR (pruebas en caja, veredicto) lo
    // confundían. El encargo trae el detalle; aquí sólo el papel.
    const critic = h === "check" && (await isCriticTurn(dest).catch(() => false));
    parts.push(`En ESTE turno actúas como @${h}${critic ? " en su papel de CRÍTICO DEL PLAN" : ""}; tu identidad de siempre se queda, pero aplica este rol.`);
    parts.push(FACTORY_COMMON);
    parts.push(critic ? (await import("./factory-roles")).CRITIC_ROLE : ROLE_INSTRUCTIONS[h]);
    // Convenciones del repo (`.ghosty/factory.md`): le ganan a lo genérico de arriba.
    const { factoryTurnFor } = await import("./factory-team.server");
    const ft = await factoryTurnFor(h, dest, "").catch(() => null);
    if (ft?.repo) parts.push(...repoConventionLines(ft.repo, h, ft.notes, ft.roleNotes));
    // El entorno de pruebas declarado: @build y @check lo aplican con una llamada exacta; @plan
    // sólo necesita saber si ya existe para proponerlo cuando falta.
    if (ft?.repo && !critic) {
      const { setupLine } = await import("./factory-team");
      // La caja del pedido: @build y @check trabajan en LA MISMA (no piden otra con ensure()).
      if (h === "build" || h === "check") {
        const R = await import("./factory-runs.server");
        const root = threadRoot(dest);
        const run = dest?.channelId && root ? await R.runOfThread(dest.channelId, root).catch(() => null) : null;
        const boxId = run ? await R.runBoxIdOf(run.id) : null;
        if (boxId)
          parts.push(
            h === "build"
              ? `Caja de este pedido: \`${boxId}\` (dev-box 4 GB; la crea y la tira la plataforma). Trabaja en ella con exec/execLong/prepare de /opt/gs-sdk/sandbox.mjs usando ESE id, en /app/repo. No llames ensure() ni create(): ésta es tu caja. El puerto 4300 es de la preview; tu dev server, en el 3000.`
              : `Caja de este pedido: \`${boxId}\` (la misma donde construyó @build). Prueba en un clon LIMPIO del PR, no en el árbol de @build: \`git -C /app/repo fetch origin <rama> && git -C /app/repo worktree add -f /app/check <sha del PR>\` (bórralo y recréalo en cada revisión) y corre prepare(...) antes de cada suite para recrear la base. No edites ni empujes desde ahí. Sigue leyendo el CI.`,
          );
      }
      if (ft.setup && (h === "build" || h === "check")) parts.push(setupLine(ft.repo, ft.setup));
      if (h === "plan") {
        // Si la preview es viable se sabe al planear, no tras el build (#96, 16-oct).
        const line = await planPreviewLine(dest, ft.repo).catch(() => null);
        if (line) parts.push(line);
      }
      if (h === "check") {
        // El crítico y el revisor: si la preview toca producción, no se prueba escribiendo en ella.
        const line = await previewRiskLine(ft.repo).catch(() => null);
        if (line) parts.push(line);
      }
      if (!ft.setup && h === "plan")
        parts.push(`${ft.repo} no declara su entorno de pruebas (setup: en .ghosty/factory.md). Si el pedido toca pruebas que piden base de datos, Redis o variables de prueba, mira los services: y env: de .github/workflows/*.yml (o docker-compose) y agrega al plan un paso que proponga el bloque setup: en el mismo PR.`);
    }
    if (ft?.repo && !ft.refusal) {
      const { knowledgeLine } = await import("./factory-team");
      parts.push(knowledgeLine(ft.repo, ft.knowledge));
    }
  }
  const root = threadRoot(dest);
  if (dest?.channelId && root) {
    const R = await import("./factory-runs.server");
    const run = await R.runOfThread(dest.channelId, root).catch(() => null);
    if (run) {
      const { stageLabel } = await import("./factory-flow");
      // La FOTO del pedido (factory-digest): el rol no tiene que buscar su estado.
      const { runDigest } = await import("./factory-digest.server");
      const digest = h ? await runDigest(run).catch(() => null) : null;
      parts.push(
        digest
          ? `FOTO del pedido de ESTE hilo (de la DB, al día; usa su runId ${run.id} en las tools factory_*):\n${digest}`
          : `Pedido de ESTE hilo: #${run.id} «${run.title}», etapa «${stageLabel(run.status)}», plan v${run.planVersion}` +
              (run.prUrl ? `, PR ${run.prUrl}` : "") +
              (run.loops ? `, ${run.loops} vuelta(s) de check` : "") +
              ". Usa su runId en las tools factory_*.",
      );
    } else if (h) {
      // Hilo SIN pedido pero colgado de la tarjeta de un PR (el aviso «PR #44 abierto»): «@check
      // revisa» es revisar ESE PR, como «@coderabbit review» en GitHub. Antes @check contestaba
      // «no hay pedido, ¿qué PR?» con la tarjeta del PR justo arriba (Denik, 2026-09-30).
      const db = await import("../../db.server");
      const rootMsg = await db.getMessage(root).catch(() => null);
      const { prOfMessage } = await import("../../lib/ebdoc");
      const { loosePrReviewBrief, LOOSE_PR_BUILD_BRIEF } = await import("./factory-roles");
      const pr = rootMsg?.body ? prOfMessage(rootMsg.body) : null;
      if (pr) {
        const ref = `${pr.repo}#${pr.number}`;
        parts.push(
          `Este hilo es del PR ${ref} «${pr.title}» de ${pr.author} (https://github.com/${pr.repo}/pull/${pr.number}). NO hay pedido de la fábrica: ` +
            (h === "check"
              ? loosePrReviewBrief({ minSeverity: await looseReviewSeverity(dest.channelId, pr.repo).catch(() => null) })
              : h === "build"
                ? LOOSE_PR_BUILD_BRIEF
                : `si te piden planear algo sobre él, planéalo a partir de ese PR.`),
        );
      }
    }
    // Hilo sin pedido que habla del PR de un pedido: lo que se pida aquí no le llega a @build
    // por sí solo (el comentario del PR #8 quedó en GitHub, 01-oct). Se le dice cómo hacerlo llegar.
    if (!run && h) {
      const [other] = await runsMentionedInThread(dest).catch(() => []);
      if (other) {
        const { stageLabel } = await import("./factory-flow");
        const { runDigest } = await import("./factory-digest.server");
        const digest = await runDigest(other).catch(() => null);
        parts.push(
          `Este hilo habla del PR del pedido #${other.id} «${other.title}» (etapa «${stageLabel(other.status)}»): si es un cambio para @build, ` +
            `regístralo con factory_note (pr o runId ${other.id}); no basta un comentario en GitHub ni en este hilo.` +
            (digest ? `\nFOTO de ese pedido:\n${digest}` : ""),
        );
      }
    }
  }
  // Lo abierto del room: un rol que contesta sin mirarlo duplica trabajo (sprint encima de otro,
  // ticket que ya está en otro PR). Va siempre; para más, factory_room / factory_context.
  if (h && dest?.channelId) {
    const { roomIndex } = await import("./factory-digest.server");
    const idx = await roomIndex(dest.channelId).catch(() => null);
    if (idx) parts.push(`ABIERTO EN ESTE ROOM:\n${idx}`);
    parts.push(
      "Tu foto del pedido y del room ya viene arriba. Si necesitas más, usa factory_context (un pedido a detalle: plan completo, notas, bitácora), " +
        "factory_room (todo el room) o chat_search con room:true (lo que se dijo en otros hilos); no adivines ni digas que no tienes acceso.",
    );
  }
  // Sin CI, «verde» no significa nada: el primer pedido que conviene es el CI starter.
  if (h === "plan" && dest?.channelId) {
    const noCi = await reposWithoutCi(dest.channelId).catch(() => []);
    if (noCi.length)
      parts.push(
        `El repo ${noCi.join(", ")} NO tiene CI: nada corre las pruebas fuera de la caja. Si no te piden otra cosa, ` +
          `dile al dueño que lo prepare con «Preparar repo» (el ícono de GitHub del room → «Listo para agentes»): un solo PR con CI, AGENTS.md, CODEOWNERS y Dependabot.`,
      );
  }
  // Misma frase que Tasks: tenerlas y no llamarlas es el otro modo de falla.
  parts.push(
    "Tus tools de la fábrica (factory_plan_submit, factory_plan_critique, factory_build_done, factory_check_verdict, factory_status, factory_close, factory_ci_starter, factory_repo_prep, factory_preview, factory_sprint_submit, factory_note, factory_message, factory_context, factory_room, factory_run_review, factory_card) " +
      "ya están disponibles en este turno: LLÁMALAS para cerrar tu paso; sin ellas la estafeta no avanza. " +
      "Si la persona no encuentra la tarjeta del pedido, bájala con factory_card; nunca pegues tú el bloque ```gt-run```." +
      notaNombres(toolChannel),
  );
  parts.push(
    "ALERTAS DE MONITOREO: si piden conectar su monitoreo (Datadog, Grafana, Better Stack, UptimeRobot o cualquier herramienta con webhooks), usa alert_webhook_create { name } en el canal donde deben caer; la URL es SECRETA (sólo a quien la pidió). También alert_webhook_list y alert_webhook_delete. Para Sentry usa su conector.]",
  );
  // La brevedad va AL FINAL a propósito: en medio del contexto el modelo la ignoraba y
  // contestaba con viñetas y la historia de sus intentos (MailMask, 2026-10-01).
  if (h && (FACTORY_HANDLES as readonly string[]).includes(h))
    parts.push(
      "ÚLTIMA REGLA, la más importante: tu respuesta en el hilo es corta y sin encabezados, sin repetir lo que otro rol ya dijo. Un solo dato = 1 o 2 renglones. Varios datos (pendientes, PRs, tickets) = viñetas de una línea, máximo 4, nunca un párrafo con punto y seguido. " +
        "Di qué hiciste, dónde quedó (la tarjeta, el documento, el PR) y qué falta de la persona. " +
        "No cuentes tus intentos, pruebas ni errores internos, y no repitas lo que ya muestra la tarjeta.",
    );
  return parts.join(" ");
}

// Cuáles repos del room no tienen CI (cacheado 10 min: esto corre en cada turno de @plan).
const ciCache = new Map<string, { at: number; has: boolean }>();
async function reposWithoutCi(channelId: number): Promise<string[]> {
  const db = await import("../../db.server");
  const rows = await db.listRoomRepos(channelId);
  const out: string[] = [];
  for (const r of rows) {
    const hit = ciCache.get(r.repo);
    let has = hit && Date.now() - hit.at < 600_000 ? hit.has : null;
    if (has === null) {
      const { hasWorkflows } = await import("./ci-starter.server");
      has = await hasWorkflows(r.connectedBy, r.repo).catch(() => true);
      ciCache.set(r.repo, { at: Date.now(), has });
    }
    if (!has) out.push(r.repo);
  }
  return out;
}
