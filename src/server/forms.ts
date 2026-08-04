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
      draftTtlDays: f.draftTtlDays,
    };
  });
});

/**
 * Los destinos de un formulario, para el panel del DUEÑO.
 *
 * Devuelve el SECRETO, que es lo que distingue esta lectura de la del agente: sin él nadie
 * puede verificar la firma del otro lado, y es lo único que hay que copiar a mano.
 */
export const listFormHooksFn = createServerFn({ method: "GET" })
  .validator((d: { formId: string }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return [];
    const { dbq } = await import("../dbq.server");
    const { getForm } = await import("./forms/publish.server");
    // `getForm` está acotado al namespace: un formId de otro workspace no resuelve.
    const form = await getForm(String(data.formId ?? ""));
    if (!form) return [];
    const rows = await dbq(
      `SELECT id, url, secret, enabled, include_files, disabled_reason FROM gt_form_hooks WHERE form_id = ?`,
      [form.id]
    );
    return rows.map((r) => ({
      id: r.id!,
      url: r.url!,
      secret: r.secret!,
      enabled: r.enabled === "1",
      includeFiles: r.include_files === "1",
      disabledReason: r.disabled_reason ?? null,
    }));
  });

/**
 * Alta, activación y borrado de un destino. Todo pasa por aquí y todo exige sesión: activar
 * es la decisión que manda un intake a un tercero, y no puede tomarla el agente.
 */
export const formHookActionFn = createServerFn({ method: "POST" })
  .validator((d: { formId: string; op: "add" | "enable" | "disable" | "delete"; url?: string; hookId?: string; includeFiles?: boolean }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return { ok: false as const, error: "sin sesión" };
    const { getForm } = await import("./forms/publish.server");
    const form = await getForm(String(data.formId ?? ""));
    if (!form) return { ok: false as const, error: "ese formulario no existe" };
    const hooks = await import("./forms/webhooks.server");

    if (data.op === "add") {
      const r = await hooks.proposeHook({
        formId: form.id,
        url: String(data.url ?? "").trim(),
        includeFiles: data.includeFiles === true,
      });
      if (!r.ok) return { ok: false as const, error: r.error };
      // Alta y activación en un gesto: el dueño ya está autenticado y acaba de escribir la
      // URL. Si el ping falla se queda apagado con el motivo, que es justo la señal útil.
      const on = await hooks.enableHook(r.hook.id);
      return on.ok ? { ok: true as const } : { ok: false as const, error: on.error };
    }

    const propio = (await hooks.listHooks(form.id)).some((h) => h.id === data.hookId);
    // El hookId viene del cliente: sin esto se podría activar el destino de otro formulario
    // del mismo workspace.
    if (!data.hookId || !propio) return { ok: false as const, error: "ese destino no existe" };

    if (data.op === "enable") {
      const on = await hooks.enableHook(data.hookId);
      return on.ok ? { ok: true as const } : { ok: false as const, error: on.error };
    }
    if (data.op === "disable") {
      await hooks.disableHook(data.hookId, "lo desconectaste desde el panel");
      return { ok: true as const };
    }
    await hooks.deleteHook(data.hookId);
    return { ok: true as const };
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
