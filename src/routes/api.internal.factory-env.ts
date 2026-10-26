import { createFileRoute } from "@tanstack/react-router";

// ── Endpoint interno: las variables de la preview de un repo, desde la terminal ─────────
//
// `ghosty factory env ls|push` (20-oct): las variables viven en la compu de la persona (su `.env`,
// su gestor de contraseñas), no en el teléfono. Su agente de terminal las lee ahí y las sube. Lo
// mismo que la hoja «Variables» de la preparación del repo (`savePreviewEnvFn`), firmado por quien
// manda el comando (`sub`): ver la lista lo puede cualquier miembro que vea el repo; guardar, sólo
// el dueño. Los valores entran a la bóveda de gs y nunca salen: aquí sólo viajan NOMBRES.
//
// `ls` dice qué falta: lo que pide `.env.example` y lo que nombran los pedidos que @check escaló
// porque la preview no arrancaba (#125: 5 variables que el repo no declaraba).

const bad = (error: string, status = 400) => Response.json({ error }, { status });
const ENV_NAME = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

type Body = { sub?: string; repo?: string; action?: string; dotenv?: string; replace?: boolean };

/** Los pedidos de ese repo escalados por bloqueo, con las variables que nombra @check. */
async function blockedRunsOf(repo: string): Promise<{ id: number; title: string; keys: string[] }[]> {
  const { dbq } = await import("../dbq.server");
  const R = await import("../server/apps/factory-runs.server");
  const rows = await dbq("SELECT id FROM gt_factory_runs WHERE LOWER(repo) = LOWER(?) AND status = 'escalated' ORDER BY id DESC LIMIT 20", [repo]).catch(() => []);
  const out: { id: number; title: string; keys: string[] }[] = [];
  for (const r of rows) {
    const run = await R.getRun(Number(r.id));
    if (!run) continue;
    const [ev] = await dbq("SELECT type FROM gt_factory_events WHERE run_id = ? AND type IN ('check_blocked', 'check_fail') ORDER BY id DESC LIMIT 1", [run.id]).catch(() => []);
    if (ev?.type !== "check_blocked") continue;
    const esc = await R.escalationOf(run);
    out.push({ id: run.id, title: run.title, keys: [...new Set(esc?.findings.match(ENV_NAME) ?? [])] });
  }
  return out;
}

export const Route = createFileRoute("/api/internal/factory-env")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const raw = await request.text();
        if (!((await import("../server/partner-sig.server")).partnerRequestOk(request, raw))) {
          return new Response("firma inválida", { status: 403 });
        }
        let body: Body;
        try {
          body = JSON.parse(raw) as Body;
        } catch {
          return bad("json inválido");
        }
        if (!body.sub) return bad("falta sub");
        const db = await import("../db.server");
        const users = await import("../users.server");
        const member = (await users.listAllMembers().catch(() => [])).find((m) => m.sub === body.sub && !m.banned);
        if (!member) return bad("no eres miembro de este espacio de Teams (entra una vez desde el navegador)", 403);
        const { isOwner } = await users.resolvePermissions(member.email, member.isOwner);
        const wanted = String(body.repo ?? "").trim().toLowerCase();
        const entry = (await db.listWorkspaceRoomRepos(member.sub, isOwner)).find((r) => r.repo.toLowerCase() === wanted);
        if (!entry) return bad("ese repo no está conectado a ningún room que veas (ghosty factory rooms ls)", 404);
        const repo = entry.repo;
        const P = await import("../server/apps/preview.server");

        try {
          if (body.action === "ls") {
            const { repoReadiness } = await import("../server/apps/readiness.server");
            const rd = await repoReadiness(member.sub, repo, { fresh: true }).catch((e: Error) => ({ error: e.message }));
            const facts = "error" in rd ? null : rd.facts;
            const keys = facts ? null : await P.gsPreview("env-keys", { repo }).catch(() => null);
            const saved: string[] = facts?.envSavedKeys ?? (Array.isArray(keys?.keys) ? keys.keys : []) ?? [];
            const example = facts?.envExampleKeys ?? [];
            const blocked = await blockedRunsOf(repo);
            const wantedKeys = [...new Set([...example, ...blocked.flatMap((b) => b.keys)])];
            const savedSet = new Set(saved);
            return Response.json({
              repo,
              rooms: entry.rooms.map((r) => r.slug),
              canWrite: isOwner,
              saved,
              example,
              blocked,
              missing: wantedKeys.filter((k) => !savedSet.has(k)),
              risks: facts?.envRisks ?? (Array.isArray(keys?.risks) ? keys.risks : []),
              ...("error" in rd ? { readinessError: rd.error } : {}),
            });
          }
          if (body.action === "set") {
            if (!isOwner) return bad("sólo el dueño del espacio guarda variables", 403);
            const dotenv = String(body.dotenv ?? "").trim();
            if (!dotenv) return bad("las variables no pueden ir vacías");
            if (dotenv.length > 32_000) return bad("demasiado largo");
            const out = await P.gsPreview("env-set", { repo, dotenv, merge: !body.replace });
            const { invalidateReadiness } = await import("../server/apps/readiness.server");
            invalidateReadiness(repo);
            const R = await import("../server/apps/factory-runs.server");
            await R.retryPreviews({ repo, envChanged: true });
            return Response.json({
              repo,
              keys: (out?.keys ?? []) as string[],
              risks: Array.isArray(out?.risks) ? out.risks : [],
              // Lo que sigue: que @check vuelva a revisar los que esto desbloquea.
              blocked: (await blockedRunsOf(repo)).map((b) => ({ id: b.id, title: b.title })),
            });
          }
          return bad("action: ls | set");
        } catch (e) {
          return bad((e as Error).message, 500);
        }
      },
    },
  },
});
