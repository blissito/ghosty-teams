import { createFileRoute } from "@tanstack/react-router";

// ── Endpoint interno: analytics de novedades (para el admin de gs) ──────────
// El estado "visto" vive en Teams per-tenant (gt_announcement_seen). Este endpoint
// AGREGA across namespaces para que gs muestre "quién la vio, en qué workspace" y
// permita resetear. Firmado con GHOSTY_PARTNER_SECRET (sig=HMAC(ts.announcement-admin)).
// La lista de namespaces viene de ANNOUNCEMENT_NAMESPACES (comma). TODO: descubrirlos
// dinámicamente en vez de env (ver todo_platform_admin_screens).
//
//   GET  /api/internal/announcements?ts&sig            → { reads: [...] }
//   POST /api/internal/announcements?ts&sig  body {announcementId?, userSub?} → { ok, deleted }

async function verify(ts: string, sig: string): Promise<boolean> {
  const crypto = await import("node:crypto");
  const secret = process.env.GHOSTY_PARTNER_SECRET;
  if (!secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${ts}.announcement-admin`).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) <= 300;
}

function namespaces(): string[] {
  return (process.env.ANNOUNCEMENT_NAMESPACES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Query sqld crudo contra un namespace específico (bypass currentNamespace).
async function sqld(ns: string, sql: string, args: { type: string; value?: string }[] = []) {
  const url = process.env.SQLD_URL ?? "http://127.0.0.1:8100";
  const auth = process.env.SQLD_AUTH_TOKEN ?? "";
  const headers: Record<string, string> = { "Content-Type": "application/json", "x-namespace": ns };
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
        const u = new URL(request.url);
        if (!(await verify(u.searchParams.get("ts") ?? "", u.searchParams.get("sig") ?? "")))
          return new Response("firma inválida", { status: 403 });
        const reads: Array<{ announcementId: string; sub: string; name: string | null; email: string | null; ns: string; seenAt: number }> = [];
        for (const ns of namespaces()) {
          try {
            const rows = await sqld(
              ns,
              `SELECT s.announcement_id AS aid, s.user_sub AS sub, s.seen_at AS seen, u.name AS name, u.email AS email
               FROM gt_announcement_seen s LEFT JOIN gc_users u ON u.sub = s.user_sub
               ORDER BY s.seen_at DESC`
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
        const u = new URL(request.url);
        if (!(await verify(u.searchParams.get("ts") ?? "", u.searchParams.get("sig") ?? "")))
          return new Response("firma inválida", { status: 403 });
        const body = (await request.json().catch(() => ({}))) as { announcementId?: string; userSub?: string };
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
