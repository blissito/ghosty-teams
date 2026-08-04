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
      fichaMode: f.fichaMode,
    };
  });
});

/**
 * Prende o apaga la ficha por respuesta.
 *
 * ⚠️ Sólo hacia ADELANTE: no hay backfill al prenderla. Publicar de golpe las fichas de 80
 * respuestas viejas llenaría el hilo justo con lo que este diseño evita, y la ficha de una
 * respuesta concreta se pide con `form_ficha`. `listForms` ya está acotado al namespace del
 * tenant, así que un formId de otro workspace no resuelve.
 */
export const setFormFichaModeFn = createServerFn({ method: "POST" })
  .validator((d: { formId: string; mode: "off" | "auto" }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return { ok: false as const, error: "sin sesión" };
    const { dbq } = await import("../dbq.server");
    const { getForm } = await import("./forms/publish.server");
    const form = await getForm(String(data.formId ?? ""));
    if (!form) return { ok: false as const, error: "ese formulario no existe" };
    const mode = data.mode === "auto" ? "auto" : "off";
    // UPDATE directo y NO `updateForm`: esto no cambia el formulario público, así que no
    // tiene por qué publicar una versión nueva de su artefacto.
    await dbq(`UPDATE gt_forms SET ficha_mode = ?, updated_at = unixepoch() WHERE id = ?`, [mode, form.id]);
    return { ok: true as const, fichaMode: mode };
  });
