import { createFileRoute } from "@tanstack/react-router";

// ── Endpoint interno: decidir un pedido de la fábrica desde la terminal ──────────
//
// Lo que hace la tarjeta (`factoryDecisionFn`, `factoryMergeFn`) pero a nombre de una persona que
// llega por gs (`ghosty factory runs approve|changes|merge|card`, 19-oct; `resume|stop|cancel|close|retry_preview` desde la app, 20-oct): la fábrica como
// complemento de un agente de terminal. Firma QUIEN manda el comando (`sub`), con el mismo permiso
// que la tarjeta: ser miembro del espacio y ver el room del pedido.
//
// ⚠️ Aprobar exige la `version` del plan que la persona vio (`runs show`): el 13-oct un «aprobar»
// sin versión firmó a ciegas un v2 que nadie había leído (#74). `decide` rechaza una versión vieja.
//
// Firma de partner sobre el CUERPO en crudo (`ts.<rawBody>`), como `api/internal/post-message`.

async function verify(ts: string, sig: string, rawBody: string): Promise<boolean> {
  const crypto = await import("node:crypto");
  const secret = process.env.GHOSTY_PARTNER_SECRET;
  if (!secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) <= 300;
}

const bad = (error: string, status = 400) => Response.json({ error }, { status });

type Body = {
  runId?: number;
  action?: string;
  version?: number;
  note?: string;
  checkScope?: string;
  skipPreview?: boolean;
  dotenv?: string;
  sub?: string;
  /** `close`: además de cerrar, que Dependabot ignore la versión mayor o la dependencia. */
  ignore?: "major" | "dependency" | null;
};

export const Route = createFileRoute("/api/internal/factory-act")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const raw = await request.text();
        if (!(await verify(request.headers.get("x-ghosty-ts") ?? "", request.headers.get("x-ghosty-sig") ?? "", raw))) {
          return new Response("firma inválida", { status: 403 });
        }
        let body: Body;
        try {
          body = JSON.parse(raw) as Body;
        } catch {
          return bad("json inválido");
        }
        if (!body.sub) return bad("falta sub");
        const R = await import("../server/apps/factory-runs.server");
        const run = await R.getRun(Number(body.runId));
        if (!run) return bad("pedido no encontrado", 404);

        const db = await import("../db.server");
        const users = await import("../users.server");
        const member = (await users.listAllMembers().catch(() => [])).find((m) => m.sub === body.sub && !m.banned);
        if (!member) return bad("no eres miembro de este espacio de Teams (entra una vez desde el navegador)", 403);
        const { isOwner } = await users.resolvePermissions(member.email, member.isOwner);
        const ch = await db.getChannelById(run.channelId);
        if (!ch || !(await db.canSeeChannel(ch, member.sub, isOwner))) return bad("no ves el room de ese pedido", 403);
        const origin = await (await import("../origin.server")).reqOrigin().catch(() => "");

        try {
          if (body.action === "card") {
            const id = await R.ensureRunCard(run, { force: true });
            return id ? Response.json({ ok: true, status: run.status, cardMsgId: id }) : bad("no pude publicar la tarjeta", 500);
          }
          if (body.action === "approve" || body.action === "changes") {
            if (run.status !== "plan_review" && run.status !== "escalated")
              return bad(`el pedido está en «${run.status}»: no hay plan que firmar`, 409);
            const version = Number(body.version);
            if (body.action === "approve" && run.status === "plan_review" && !(version > 0))
              return bad(`falta la versión del plan que leíste (va en v${run.planVersion}): ghosty factory runs show ${run.id} --full`);
            if (body.action === "changes" && !String(body.note ?? "").trim()) return bad("di qué cambios pides");
            const next = await R.decide({
              run,
              version: version > 0 ? version : run.planVersion,
              decision: body.action,
              // También al aprobar: la nota de «otra vuelta» le llega a @build.
              note: body.note ? String(body.note).slice(0, 4000) : undefined,
              checkScope: body.checkScope ? String(body.checkScope) : undefined,
              sub: member.sub,
              who: member.name || "alguien",
              origin,
            });
            return Response.json({ ok: true, status: next.status });
          }
          // Escalado por algo que @build no puede hacer y que la persona ya resolvió: @check revisa
          // otra vez el mismo PR, sin otra vuelta de @build.
          if (body.action === "recheck") {
            if (run.status !== "escalated") return bad(`el pedido está en «${run.status}», no escalado`, 409);
            const next = await R.recheck({ run, sub: member.sub, who: member.name || "alguien", note: body.note ? String(body.note) : undefined, origin });
            return Response.json({ ok: true, status: next.status });
          }
          // Las variables de la preview del repo del pedido (lo de «Variables» en la preparación del
          // repo): entran a la bóveda de gs y nunca vuelven; se contestan sólo los NOMBRES. Sólo el
          // dueño, como en la web. Las previews abiertas del repo se reconstruyen con ellas.
          if (body.action === "env") {
            if (!isOwner) return bad("sólo el dueño del espacio guarda variables", 403);
            if (!run.repo) return bad("el pedido no tiene repo");
            const dotenv = String(body.dotenv ?? "").trim();
            if (!dotenv) return bad("las variables no pueden ir vacías");
            if (dotenv.length > 32_000) return bad("demasiado largo");
            const { gsPreview } = await import("../server/apps/preview.server");
            const out = await gsPreview("env-set", { repo: run.repo, dotenv, merge: true });
            const { invalidateReadiness } = await import("../server/apps/readiness.server");
            invalidateReadiness(run.repo);
            await R.retryPreviews({ repo: run.repo, envChanged: true });
            return Response.json({ ok: true, keys: (out?.keys ?? []) as string[] });
          }
          if (body.action === "merge") {
            if (run.status !== "pr_review") return bad(`el pedido está en «${run.status}», no esperando merge`, 409);
            const r = await R.mergeRun(run, member.sub, { skipPreview: body.skipPreview === true });
            // CI corriendo o rama recién puesta al día: queda en cola y el tick lo mergea al pasar.
            if (!r.ok && r.queue) {
              await R.queueMerge(run.id, member.sub);
              return Response.json({ ok: true, status: run.status, queued: true });
            }
            if (!r.ok) return bad(r.error, 409);
            return Response.json({ ok: true, status: "done", queued: false });
          }
          // Lo de la tarjeta web para un pedido sin avanzar: retomar al rol de la etapa, detener su
          // turno o cancelar el pedido (la app de iOS, 20-oct).
          if (body.action === "resume" || body.action === "stop" || body.action === "cancel") {
            const { runPersonAction } = await import("../server/apps/factory");
            return Response.json(await runPersonAction(run, body.action, { sub: member.sub, name: member.name, isOwner }));
          }
          // Escalado `skip` (easybits #129, 20-oct): cerrar el PR, y si se pide, que Dependabot ignore
          // la versión mayor o la dependencia. Con el GitHub de quien conectó el repo.
          if (body.action === "close") {
            const ignore = body.ignore ?? null;
            if (ignore !== null && ignore !== "major" && ignore !== "dependency") return bad("ignore: major | dependency | null");
            const next = await R.closeRunPr(run, { ignore, who: member.name || "alguien" });
            return Response.json({ ok: true, status: next.status });
          }
          // Escalado `platform`: la preview se pide otra vez desde cero (el tick la levanta).
          if (body.action === "retry_preview") {
            if (run.status === "done" || run.status === "cancelled") return bad(`el pedido está en «${run.status}»`, 409);
            if (!run.prUrl) return bad("el pedido todavía no tiene PR", 409);
            const retried = await R.retryPreviews({ runId: run.id, force: true });
            if (!retried) return bad("la preview de este repo está apagada («Sin preview»)", 409);
            await R.logEvent(run.id, "preview_retried", member.name || member.sub);
            return Response.json({ ok: true, status: run.status, retried });
          }
          return bad("action: approve | changes | recheck | env | merge | card | resume | stop | cancel | close | retry_preview");
        } catch (e) {
          return bad((e as Error).message, 409);
        }
      },
    },
  },
});
