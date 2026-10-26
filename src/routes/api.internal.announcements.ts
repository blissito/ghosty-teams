import { createFileRoute } from "@tanstack/react-router";
import { tokenPara } from "../dbq.server";

// ── Endpoint interno: analytics de novedades (para el admin de gs) ──────────
// El estado "visto" vive en Teams per-tenant (gt_announcement_seen). Este endpoint
// AGREGA across namespaces para que gs muestre "quién la vio, en qué workspace" y
// permita resetear. Firma de partner en headers sobre el cuerpo (el GET firma su ruta).
// La lista de namespaces viene de ANNOUNCEMENT_NAMESPACES (comma). TODO: descubrirlos
// dinámicamente en vez de env (ver todo_platform_admin_screens).
//
//   GET  /api/internal/announcements            → { reads: [...] }
//   POST /api/internal/announcements  body {announcementId?, userSub?} → { ok, deleted }

/** Firma de partner sobre el cuerpo (un GET firma `GET <ruta>`), ver `partner-sig.server`.
 *  ⚠️ Transición: el formato viejo `ts.announcement-admin` en la query sólo mientras gs migra. */
async function signed(request: Request, raw: string | null): Promise<boolean> {
  const S = await import("../server/partner-sig.server");
  const msg = raw ?? S.canonicalGet(new URL(request.url).pathname);
  return S.partnerRequestOk(request, msg) || S.legacyLiteralOk(request, "announcement-admin");
}

function namespaces(): string[] {
  // Dedupe: un ns repetido en el env duplicaría TODAS sus filas en el agregado.
  return [
    ...new Set(
      (process.env.ANNOUNCEMENT_NAMESPACES ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    ),
  ];
}

// Query sqld crudo contra un namespace específico (bypass currentNamespace).
//
// Este bypass es DELIBERADO y legítimo: los anuncios se agregan leyendo varios
// workspaces. Lo que cambia es cómo se autentica: antes iba un único token
// compartido —sin acotar, o sea con acceso a TODA la instancia— y ahora se firma
// uno por cada namespace de la vuelta, acotado a ese y con minutos de vida.
// Sigue leyendo lo mismo, pero un token que se escape sólo sirve para el
// workspace del que salió.
async function sqld(ns: string, sql: string, args: { type: string; value?: string }[] = []) {
  const url = process.env.SQLD_URL ?? "http://127.0.0.1:8100";
  const headers: Record<string, string> = { "Content-Type": "application/json", "x-namespace": ns };
  const auth = tokenPara(ns);
  if (auth) headers.Authorization = `Bearer ${auth}`;
  const res = await fetch(`${url}/v2/pipeline`, {
    method: "POST",
    headers,
    body: JSON.stringify({ requests: [{ type: "execute", stmt: { sql, args } }, { type: "close" }] }),
  });
  if (!res.ok) throw new Error(`sqld ${res.status}`);
  const data = (await res.json()) as {
    results: Array<{ type: string; response?: { result: { cols: { name: string }[]; rows: { value?: unknown }[][] } }; error?: { message: string } }>;
  };
  const r = data.results[0];
  if (!r || r.type === "error") throw new Error(r?.error?.message ?? "sqld error");
  const cols = r.response!.result.cols.map((c) => c.name);
  return r.response!.result.rows.map((row) =>
    Object.fromEntries(cols.map((c, i) => [c, row[i]?.value == null ? null : String(row[i]!.value)]))
  );
}

export const Route = createFileRoute("/api/internal/announcements")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!(await signed(request, null))) return new Response("firma inválida", { status: 403 });
        const reads: Array<{ announcementId: string; sub: string; name: string | null; email: string | null; ns: string; seenAt: number }> = [];
        for (const ns of namespaces()) {
          try {
            // GROUP BY (announcement, user): garantiza UNA fila por persona aunque gc_users
            // tenga filas duplicadas por sub (el LEFT JOIN, si no, multiplicaría cada vista).
            const rows = await sqld(
              ns,
              `SELECT s.announcement_id AS aid, s.user_sub AS sub, MAX(s.seen_at) AS seen,
                      MAX(u.name) AS name, MAX(u.email) AS email
               FROM gt_announcement_seen s LEFT JOIN gc_users u ON u.sub = s.user_sub
               GROUP BY s.announcement_id, s.user_sub
               ORDER BY seen DESC`
            );
            for (const r of rows)
              reads.push({
                announcementId: r.aid!,
                sub: r.sub!,
                name: r.name ?? null,
                email: r.email ?? null,
                ns,
                seenAt: Number(r.seen ?? 0),
              });
          } catch {
            // namespace sin la tabla / inaccesible → se omite
          }
        }
        return Response.json({ reads });
      },
      POST: async ({ request }) => {
        const raw = await request.text();
        if (!(await signed(request, raw))) return new Response("firma inválida", { status: 403 });
        const body = (() => { try { return JSON.parse(raw || "{}"); } catch { return {}; } })() as { announcementId?: string; userSub?: string };
        let deleted = 0;
        for (const ns of namespaces()) {
          const conds: string[] = [];
          const args: { type: string; value?: string }[] = [];
          if (body.announcementId) {
            conds.push("announcement_id = ?");
            args.push({ type: "text", value: body.announcementId });
          }
          if (body.userSub) {
            conds.push("user_sub = ?");
            args.push({ type: "text", value: body.userSub });
          }
          const where = conds.length ? ` WHERE ${conds.join(" AND ")}` : "";
          try {
            await sqld(ns, `DELETE FROM gt_announcement_seen${where}`, args);
            deleted++;
          } catch {
            /* omite */
          }
        }
        return Response.json({ ok: true, deleted });
      },
    },
  },
});
