import { createServerFn } from "@tanstack/react-start";
import { sessionUser } from "./chat";

// Lista los formularios de intake de ESTE team. Datos 100% locales (`gt_forms`): antes esto
// leía `gc_expediente_forms` —que nadie llenaba nunca, así que la página siempre estaba
// vacía— y pedía nombre/slug/URL a EasyBits en cada render. Ya no hay llamada de red.
//
// La forma de retorno se conserva tal cual porque `routes/forms.tsx` la consume así.
export const listTeamFormsFn = createServerFn({ method: "GET" }).handler(async () => {
  const me = await sessionUser();
  if (!me) return [];

  const { listForms, formUrl } = await import("./forms/publish.server");
  const { dbq, num } = await import("../dbq.server");

  const forms = await listForms();
  if (!forms.length) return [];

  // Nombre y slug del room, en UNA consulta (la lista es corta; un JOIN por fila sería
  // gratis en sqld pero N round-trips).
  const rooms = new Map<number, { name: string | null; slug: string | null }>();
  const ids = [...new Set(forms.map((f) => f.channelId))];
  const chans = await dbq(
    `SELECT id, name, slug FROM gc_channels WHERE id IN (${ids.map(() => "?").join(",")})`,
    ids
  );
  for (const c of chans) rooms.set(num(c.id), { name: c.name ?? null, slug: c.slug ?? null });

  return forms.map((f) => {
    const room = rooms.get(f.channelId);
    return {
      formId: f.id,
      name: f.title,
      slug: f.shareSlug,
      url: formUrl(f),
      roomName: room?.name ?? null,
      roomSlug: room?.slug ?? null,
      submissions: f.submissionCount,
      lastSubmittedAt: f.lastSubmittedAt,
      status: f.status,
    };
  });
});
