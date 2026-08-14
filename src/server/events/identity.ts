import { createServerFn } from "@tanstack/react-start";

// Identificarse para participar en un room abierto: pedir código y canjearlo.
//
// ⚠️ Este archivo NO puede llamarse `.server.ts` aunque todo lo que hace sea de servidor:
// el import-protection prohíbe que un `.server.ts` entre al bundle del cliente, y la
// página importa estas funciones por nombre para llamarlas por RPC. Misma razón que
// `events/chat.ts`. Los módulos que sí llevan el sufijo se importan DINÁMICAMENTE dentro
// de los handlers, así que nunca cruzan.

/** Resuelve el room público de una liga, o `null`. */
async function room(slug: string) {
  await (await import("../schema.server")).ensureSchema().catch(() => {});
  const db = await import("../../db.server");
  const ch = await db.channelByShareSlug(slug);
  return ch ? { db, ch } : null;
}

/**
 * Paso 1: nombre + correo → se manda un código de 6 dígitos.
 *
 * Todos los caminos de error devuelven el MISMO texto salvo el rate limit. No confirmar
 * qué slugs existen, ni quién está baneado, ni qué correos ya están registrados: cada una
 * de esas respuestas distintas es una consulta gratis para quien esté probando.
 */
export const requestCodeFn = createServerFn({ method: "POST" })
  .validator((d: { slug: string; name: string; email: string }) => d)
  .handler(async ({ data }): Promise<{ ok: true } | { ok: false; error: string }> => {
    const { getRequest } = await import("@tanstack/react-start/server");
    const v = await import("./verify.server");

    const name = (data.name ?? "").trim().slice(0, 60);
    const email = v.normalizeEmail(data.email ?? "");
    if (name.length < 2) return { ok: false, error: "Escribe tu nombre" };
    if (!v.validEmail(email)) return { ok: false, error: "Escribe un correo válido" };

    const r = await room(data.slug);
    if (!r || !r.ch.call_mode) return { ok: false, error: "Este room no está disponible" };

    // ⚠️ Dos cubetas, y las dos hacen falta. Por IP frena a quien pide códigos en masa;
    // **por CORREO** frena que alguien use este endpoint para bombardear el buzón de otra
    // persona, que es abuso hacia un tercero que ni siquiera está aquí.
    const { rateCheck, clientIp } = await import("../forms/rate.server");
    const ip = clientIp(getRequest());
    const porIp = await rateCheck(`evtcode:${r.ch.id}`, ip, {
      scope: "evtcode",
      windowS: 300,
      maxWithIp: 6,
      maxNoIp: 3,
    });
    if (!porIp.allowed) return { ok: false, error: "Demasiados intentos. Espera unos minutos." };
    const porCorreo = await rateCheck(`evtcode:${r.ch.id}`, email, {
      scope: "evtmail",
      windowS: 900,
      maxWithIp: 4,
      maxNoIp: 4,
    });
    if (!porCorreo.allowed) return { ok: false, error: "Ya te mandamos varios códigos. Revisa tu correo." };

    const code = v.newCode();
    const { banned } = await r.db.startEventVerification({
      channelId: r.ch.id,
      name,
      email,
      codeHash: v.hashCode(code),
      expiresAt: Math.floor(Date.now() / 1000) + v.VERIFY_TTL_S,
      ipHash: porIp.ipHash,
    });
    // A quien está vetado se le contesta que SÍ, y no llega ningún correo. Decirle
    // "estás vetado" sólo le enseña a volver con otra dirección.
    if (banned) return { ok: true };

    // El origin se lee del REQUEST vivo: cada workspace sirve el room desde su propio
    // subdominio, así que una base fija mandaría a la gente al host equivocado.
    const origin = await import("../../origin.server")
      .then((m) => m.reqOrigin())
      .catch(() => "");
    await v.sendCodeEmail({
      to: email,
      code,
      roomTitle: r.ch.call_title || r.ch.name,
      roomUrl: origin ? `${origin.replace(/\/$/, "")}/room/${encodeURIComponent(data.slug)}` : undefined,
    });
    return { ok: true };
  });

/**
 * Paso 2: el código → cookie de invitado y permiso para participar.
 *
 * El `sub` lo acuña el SERVIDOR (`guestSubForEvents`) y se ata al correo sólo aquí, al
 * acertar. Atarlo al pedir el código dejaría que cualquiera reclamara el correo de otro
 * con sólo escribirlo.
 */
export const verifyCodeFn = createServerFn({ method: "POST" })
  .validator((d: { slug: string; email: string; code: string }) => d)
  .handler(async ({ data }): Promise<{ ok: true; name: string } | { ok: false; error: string }> => {
    const v = await import("./verify.server");
    const email = v.normalizeEmail(data.email ?? "");
    const r = await room(data.slug);
    if (!r || !r.ch.call_mode) return { ok: false, error: "Este room no está disponible" };

    const fila = await r.db.eventVerificationRow(r.ch.id, email);
    // Sin fila y con fila baneada responden igual que un código incorrecto.
    if (!fila || fila.banned === 1) return { ok: false, error: "Código incorrecto" };

    const res = v.checkCode(fila, data.code ?? "", Math.floor(Date.now() / 1000));
    if (!res.ok) {
      // El intento se cuenta ANTES de contestar, y también cuando el código ya había
      // caducado: si sólo contara el fallo "limpio", pedir uno nuevo cada diez minutos
      // daría intentos infinitos.
      await r.db.bumpEventVerifyAttempt(r.ch.id, email).catch(() => {});
      if (res.reason === "agotado") return { ok: false, error: "Demasiados intentos. Pide un código nuevo." };
      if (res.reason === "caducado") return { ok: false, error: "Ese código ya caducó. Pide uno nuevo." };
      return { ok: false, error: "Código incorrecto" };
    }

    const { guestSubForEvents } = await import("./guest.server");
    const guestSub = await guestSubForEvents();
    await r.db.confirmEventVerification({ channelId: r.ch.id, email, guestSub });
    return { ok: true, name: fila.name || "Invitado" };
  });

/**
 * Grabar la llamada. Sólo el HOST — es una acción sobre la sesión de todos, y su rastro
 * queda publicado en el room.
 */
/**
 * Borra una grabación: la fila, el MP4 y su transcripción.
 *
 * ⚠️ Es irreversible y no se puede rehacer —el original vivía en la caja y ya se borró—,
 * así que sólo lo puede hacer quien modera. Y por eso el botón pide confirmación.
 */
export const deleteRecordingFn = createServerFn({ method: "POST" })
  .validator((d: { slug: string; id: number }) => d)
  .handler(async ({ data }): Promise<{ ok: true } | { ok: false; error: string }> => {
    const r = await room(data.slug);
    if (!r || !r.ch.call_mode) return { ok: false, error: "Este room no está disponible" };
    const { eventViewerFor } = await import("./access.server");
    const viewer = await eventViewerFor(r.ch);
    if (!viewer?.isHost) return { ok: false, error: "Sólo quien modera puede borrar una grabación" };

    const { dbq } = await import("../../dbq.server");
    const filas = await dbq(
      "SELECT storage_key, transcript_key FROM gt_event_recordings WHERE id = ? AND channel_id = ?",
      [data.id, r.ch.id]
    ).catch(() => []);
    const fila = filas[0];
    if (!fila) return { ok: false, error: "Esa grabación ya no existe" };

    // Primero los objetos, después la fila: al revés, un fallo a mitad deja bytes pagándose
    // en storage sin nada que apunte a ellos.
    const { del } = await import("../storage.server");
    for (const key of [fila.storage_key, fila.transcript_key]) {
      if (key) await del(String(key)).catch(() => {});
    }
    await dbq("DELETE FROM gt_event_recordings WHERE id = ? AND channel_id = ?", [data.id, r.ch.id]);
    // `call_recording_url` es la copia vieja de "la última grabación": si apuntaba a ésta,
    // se limpia, o el room seguiría ofreciendo un enlace muerto.
    if (r.ch.call_recording_url && fila.storage_key && String(r.ch.call_recording_url).includes(String(fila.storage_key))) {
      await r.db.setChannelEvent(r.ch.id, { recordingUrl: null, recordedAt: null }).catch(() => {});
    }
    return { ok: true };
  });

export const recordingFn = createServerFn({ method: "POST" })
  .validator((d: { slug: string; action: "start" | "stop" }) => d)
  .handler(async ({ data }): Promise<{ ok: true; url?: string; transcriptUrl?: string | null } | { ok: false; error: string }> => {
    const r = await room(data.slug);
    if (!r || !r.ch.call_mode) return { ok: false, error: "Este room no está disponible" };
    const { eventViewerFor } = await import("./access.server");
    const viewer = await eventViewerFor(r.ch);
    if (!viewer?.isHost) return { ok: false, error: "Sólo quien modera puede grabar" };

    const { iniciarGrabacion, detenerGrabacion } = await import("./recording.server");
    const { eventRoomName } = await import("./ticket.server");
    const { currentNamespace } = await import("../tenant.server");

    try {
      if (data.action === "start") {
        // ⚠️ Idempotente a propósito. Dos personas que moderan, o la misma tras recargar,
        // pueden pulsar Grabar creyendo que no se está grabando: sin esta puerta se
        // levantaría un segundo recorder que se come el disco y produce un archivo que
        // nadie está mirando.
        if (r.ch.call_recording_since) {
          return { ok: false, error: `Ya se está grabando (${r.ch.call_recording_by ?? "alguien"})` };
        }
        await iniciarGrabacion(r.ch, eventRoomName(await currentNamespace(), r.ch.id));
        // El "quién" se guarda para que se SEPA, no para restringir: cualquiera que modere
        // puede detenerla. Si sólo pudiera pararla quien la empezó, una grabación se
        // quedaría corriendo toda la tarde porque esa persona cerró la pestaña.
        await r.db.setChannelEvent(r.ch.id, {
          recordingBy: viewer.name ?? "quien modera",
          recordingSince: Math.floor(Date.now() / 1000),
        });
        return { ok: true };
      }
      // Se marca como detenida ANTES de la subida, que tarda. Si se hiciera después, el
      // testigo diría "grabando" durante todo el rato que el MP4 viaja a storage — y si la
      // subida falla, el room se quedaría grabando para siempre a ojos de todos.
      await r.db.setChannelEvent(r.ch.id, { recordingBy: null, recordingSince: null });
      const res = await detenerGrabacion(r.ch);
      // Cada grabación es una FILA. `call_recording_url` se sigue escribiendo porque es lo
      // que mira el código viejo, pero la verdad es la tabla: con un solo campo, la segunda
      // grabación pisaba a la primera y su enlace se perdía aunque el MP4 siguiera ahí.
      const { dbq } = await import("../../dbq.server");
      await dbq(
        `INSERT INTO gt_event_recordings (channel_id, storage_key, transcript_key, bytes, started_at, by_name, box_file)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [r.ch.id, res.key, res.transcriptKey, res.bytes, res.startedAt, viewer.name ?? null, res.file]
      ).catch((e) => console.error("[event] no pude registrar la grabación:", e));
      await r.db.setChannelEvent(r.ch.id, { recordingUrl: res.url, recordedAt: Math.floor(Date.now() / 1000) });

      // Y se ANUNCIA en el chat. El menú de arriba está bien para volver, pero quien está
      // en la sala cuando termina la sesión mira el chat, no la barra: ahí es donde el
      // enlace queda a la vista y a la mano de todos.
      //
      // ⚠️ Lo publica quien moderó, con su nombre, no un "sistema" anónimo: en una sala
      // abierta un mensaje sin cara se lee como spam. Y va con el bus, así que aparece sin
      // que nadie recargue.
      try {
        const minutos = res.startedAt ? Math.max(1, Math.round((Date.now() / 1000 - res.startedAt) / 60)) : null;
        const { id: mid } = await r.db.createMessage({
          channelId: r.ch.id,
          parentId: null,
          sender: viewer.name,
          senderSub: viewer.sub,
          avatar: "",
          body: `🎬 Grabación lista${minutos ? ` (${minutos} min)` : ""} — [ver o descargar](${res.url})\n\n_El enlace caduca en 7 días._`,
        });
        const bus = await import("../bus.server");
        const { currentNamespace } = await import("../tenant.server");
        const msg = await r.db.getMessage(mid);
        if (msg) bus.publish(bus.ch.room(await currentNamespace(), r.ch.id), { t: "message:new", msg });
      } catch (e) {
        // Que falle el anuncio no puede tumbar el guardado: la grabación YA está a salvo.
        console.error("[event] no pude anunciar la grabación:", e);
      }
      return { ok: true, url: res.url, transcriptUrl: res.transcriptUrl };
    } catch (e) {
      return { ok: false, error: (e as Error).message || "No pude grabar" };
    }
  });
