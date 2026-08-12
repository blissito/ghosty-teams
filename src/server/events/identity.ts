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
 * La URL de la sala de video, acuñada EN ESTE INSTANTE.
 *
 * ⚠️ Existe como llamada aparte por una razón concreta: el ticket dura **120 s y es de un
 * solo uso** (`ticket.server.ts`). Acuñarlo al cargar la página —como se hacía— funcionaba
 * cuando la página ERA el video; con un room donde alguien lee media hora antes de
 * entrar, ese ticket llega muerto y la sala parece rota.
 *
 * Y por eso tampoco se pre-carga el iframe: la caja de LiveKit puede estar dormida, y
 * pedirle algo la DESPIERTA. Sólo se despierta cuando alguien pulsa de verdad.
 */
export const joinCallFn = createServerFn({ method: "POST" })
  .validator((d: { slug: string }) => d)
  .handler(async ({ data }): Promise<{ ok: true; url: string } | { ok: false; error: string }> => {
    const r = await room(data.slug);
    if (!r || !r.ch.call_mode) return { ok: false, error: "Este room no está disponible" };
    // El dueño decide si la sala está abierta. Apagada, no hay URL que dar — ni siquiera
    // a quien adivine el nombre de esta función.
    if (r.ch.call_open !== 1) return { ok: false, error: "La llamada está cerrada" };

    // Entrar al video SÍ exige identidad: es lo mismo que escribir. Leer es libre.
    const { eventViewerFor, roomUrlFor } = await import("./access.server");
    const viewer = await eventViewerFor(r.ch);
    if (!viewer) return { ok: false, error: "Identifícate para entrar a la llamada" };

    const url = await roomUrlFor(r.ch, viewer);
    if (!url) return { ok: false, error: "La llamada no está configurada" };
    return { ok: true, url };
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
