import { createServerFn } from "@tanstack/react-start";
import { sessionUser } from "./chat";

// Lista los formularios de intake de ESTE team: los mapeados a un room (expediente)
// vía gc_expediente_forms, enriquecidos con nombre/slug/URL desde EasyBits (1 call
// con la platform key). Team-scoped (no todos los forms de la cuenta plataforma).
export const listTeamFormsFn = createServerFn({ method: "GET" }).handler(async () => {
  const me = await sessionUser();
  if (!me) return [];
  const { dbq, num } = await import("../dbq.server");
  const { ebFetch } = await import("./easybits-files.server");

  const maps = await dbq(
    `SELECT ef.form_id, ef.channel_id, ef.submission_count, ef.last_submitted_at,
            c.name AS room_name, c.slug AS room_slug
       FROM gc_expediente_forms ef
       LEFT JOIN gc_channels c ON c.id = ef.channel_id
      ORDER BY ef.last_submitted_at DESC`
  );
  if (!maps.length) return [];

  // Detalles del form (nombre/slug/URL/conteo) desde EasyBits.
  const details: Record<string, { name?: string; slug?: string | null; url?: string | null; submissionCount?: number }> = {};
  try {
    const res = await ebFetch(`/api/v2/forms`);
    if (res.ok) {
      const j = (await res.json()) as { items?: Array<{ id: string; name: string; slug: string | null; url: string | null; submissionCount: number }> };
      for (const f of j.items ?? []) details[f.id] = f;
    }
  } catch {
    /* best-effort */
  }

  return maps.map((m) => {
    const d = details[m.form_id!] ?? {};
    return {
      formId: m.form_id!,
      name: d.name ?? "Formulario",
      slug: d.slug ?? null,
      url: d.url ?? (d.slug ? `https://www.easybits.cloud/f/${d.slug}` : null),
      roomName: m.room_name ?? null,
      roomSlug: m.room_slug ?? null,
      submissions: d.submissionCount ?? num(m.submission_count),
      lastSubmittedAt: m.last_submitted_at ? num(m.last_submitted_at) : null,
    };
  });
});
