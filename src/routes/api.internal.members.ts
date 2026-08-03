import { createFileRoute } from "@tanstack/react-router";

// ── Endpoint interno: administrar los miembros de UN workspace desde gs ──────
//
// Lo consume el modal de asientos de `/admin/tenants`. Existe porque el padrón que manda
// para ENTRAR vive aquí, no en gs: la puerta de `completeGhostyLogin` mira `gc_users` y
// `gc_config` del tenant y no consulta a gs en ningún punto. Borrar el `Membership` allá
// es cosmético —y encima `registerMembership` lo vuelve a crear en el siguiente login—,
// así que sin este endpoint un botón de "quitar" sería mentira.
//
// Por tenant, no global: la request va a `<slug>.teams.ghosty.studio` y `currentNamespace()`
// resuelve sola por el host. Por eso la firma NO lleva el slug: el host ya lo dice, y
// meterlo en el canonical invitaría a creerle al parámetro en vez de al enrutamiento.
//
//   GET  /api/internal/members?ts&sig       → { members:[...], preapproved:[email] }
//   POST /api/internal/members?ts&sig
//        body {action:"expel"|"restore", sub}     → { ok }
//        body {action:"allow"|"disallow", email}  → { ok, preapproved }

async function verify(ts: string, sig: string): Promise<boolean> {
  const crypto = await import("node:crypto");
  const secret = process.env.GHOSTY_PARTNER_SECRET;
  if (!secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${ts}.members-admin`).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) <= 300;
}

function unauthorized() {
  return new Response("firma inválida", { status: 403 });
}

export const Route = createFileRoute("/api/internal/members")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        if (!(await verify(url.searchParams.get("ts") ?? "", url.searchParams.get("sig") ?? "")))
          return unauthorized();

        // `ensureSchema` antes de leer: la columna `banned` la añade una migración, y en un
        // workspace que nunca la corrió el SELECT reventaría con "no such column".
        await (await import("../server/schema.server")).ensureSchema().catch(() => {});
        const { listAllMembers, preapprovedEmails } = await import("../users.server");
        try {
          return Response.json({
            members: await listAllMembers(),
            preapproved: await preapprovedEmails(),
          });
        } catch (e) {
          // Un slug que no resuelve a ningún namespace tira desde `dbq` y salía como un 500
          // sin cuerpo — desde gs era indistinguible de "Teams está caído". Se responde el
          // motivo, que es lo que el panel pinta.
          return Response.json(
            { error: (e as Error)?.message ?? "no se pudo leer el padrón" },
            { status: 502 },
          );
        }
      },

      POST: async ({ request }) => {
        const url = new URL(request.url);
        if (!(await verify(url.searchParams.get("ts") ?? "", url.searchParams.get("sig") ?? "")))
          return unauthorized();

        const body = (await request.json().catch(() => ({}))) as {
          action?: string;
          sub?: string;
          email?: string;
        };
        await (await import("../server/schema.server")).ensureSchema().catch(() => {});
        const users = await import("../users.server");

        switch (body.action) {
          case "expel": {
            if (!body.sub) return Response.json({ ok: false, error: "falta sub" }, { status: 400 });
            // `expelMember` NO puede tocar al dueño (guard en su propio WHERE). Se deja así
            // en vez de comprobarlo aquí: la regla vive con la query, no con el llamador.
            await users.expelMember(body.sub);
            // Además se le retira el preaprobado, si lo tenía. Si no, la persona vuelve a
            // entrar por esa puerta en cuanto se levante el ban… o peor, se queda un
            // permiso colgando que nadie ve y que resucita a alguien meses después.
            const yo = (body.email ?? "").trim();
            if (yo) await users.setPreapprovedEmail(yo, false);
            return Response.json({ ok: true });
          }
          case "restore": {
            if (!body.sub) return Response.json({ ok: false, error: "falta sub" }, { status: 400 });
            await users.restoreMember(body.sub);
            return Response.json({ ok: true });
          }
          case "allow":
          case "disallow": {
            if (!body.email)
              return Response.json({ ok: false, error: "falta email" }, { status: 400 });
            const preapproved = await users.setPreapprovedEmail(
              body.email,
              body.action === "allow",
            );
            return Response.json({ ok: true, preapproved });
          }
          default:
            return Response.json({ ok: false, error: "acción desconocida" }, { status: 400 });
        }
      },
    },
  },
});
