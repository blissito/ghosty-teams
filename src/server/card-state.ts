// Lo que ya se contestó en una tarjeta del chat vive en el SERVIDOR, no en el navegador.
//
// Las tarjetas de pregunta (`gt-ask`), alerta (`gt-alert`) y opciones (ask-user) recordaban el
// clic sólo en el localStorage de quien lo dio. En otro dispositivo —o para otra persona del
// canal— los botones volvían: se contestaba dos veces a un agente detenido o se pedía el mismo
// fix dos veces. Mismo arreglo que el permiso de ACP (`resolved` en su fence): la respuesta se
// escribe en el mensaje y viaja a todos con el evento de siempre. El localStorage queda como
// eco optimista de quien hizo clic.
//
// El PRIMERO gana. La escritura es compare-and-swap sobre el body: dos clics simultáneos no
// pueden ganar los dos, y el que pierde recibe lo que eligió el otro para pintarlo.

import { createServerFn } from "@tanstack/react-start";

import { publishToAudience, sessionUser, threadVisibleFor, type SessionMe } from "./chat";
import { extractAlert, extractAsk, parseAskUserMd, stampFence } from "../lib/ebdoc";

export type CardClaim =
  /** Quedó escrito (o no había dónde escribirlo: mensaje viejo, turno vivo). Adelante. */
  | { ok: true; undo?: () => Promise<void> }
  /** Alguien ya contestó. `taken` es lo que eligió, para pintarlo en vez de los botones. */
  | { ok: false; taken: string };

/**
 * Reclama la tarjeta de un mensaje para `value`. `ask` guarda el texto del botón; `alert`, el
 * `send` de la acción — que es lo que la tarjeta ya compara para marcar cuál se pidió.
 *
 * `undo` existe porque contestar una pregunta puede FALLAR después de reclamarla (el agente no
 * responde): sin deshacer, la tarjeta quedaría cerrada sobre una respuesta que nunca llegó.
 */
export async function claimMessageCard(
  user: SessionMe | null,
  msgId: number,
  card: "ask" | "alert",
  value: string,
): Promise<CardClaim> {
  if (!user) throw new Error("sesión requerida");
  const db = await import("../db.server");
  const msg = await db.getMessage(msgId);
  // Mismo candado que leer el hilo: quien no ve el mensaje no puede cerrarle la tarjeta a otros.
  if (!msg || !(await threadVisibleFor(msg, { sub: user.sub, isOwner: !!user.isOwner }, db))) {
    throw new Error("mensaje no encontrado");
  }
  const { currentNamespace } = await import("./tenant.server");
  const ns = await currentNamespace();
  // Con el turno vivo el body todavía se está escribiendo, y su escritura final pisaría la
  // marca. No se estampa: queda el localStorage, que es como funcionaba antes.
  const { turnState } = await import("./turns.server");
  if (turnState(ns, msgId)) return { ok: true };

  const body = msg.body ?? "";
  let field: "answered" | "asked";
  if (card === "ask") {
    const a = extractAsk(body);
    if (!a) return { ok: true };
    if (a.answered) return { ok: false, taken: a.answered };
    // El label puede ser de las opciones declaradas o del Sí/No por defecto, que la tarjeta
    // traduce: con opciones se exige una de ellas; sin opciones, sólo un tope de largo.
    if (a.options.length ? !a.options.some((o) => o.label === value) : !value || value.length > 40) {
      throw new Error("opción inválida");
    }
    field = "answered";
  } else {
    const a = extractAlert(body);
    if (!a) return { ok: true };
    if (a.asked) return { ok: false, taken: a.asked };
    // Sólo una acción que el SERVIDOR puso en la tarjeta: lo demás sería escribir texto libre.
    if (!a.actions.some((x) => x.send === value)) throw new Error("acción inválida");
    field = "asked";
  }

  const next = stampFence(body, card === "ask" ? "gt-ask" : "gt-alert", { [field]: value });
  if (!next) return { ok: true };
  if (!(await db.swapMessageBody(msgId, body, next))) {
    // Otro clic escribió primero. Se relee para decir qué eligió.
    const now = await db.getMessage(msgId);
    const otro = card === "ask" ? extractAsk(now?.body ?? "")?.answered : extractAlert(now?.body ?? "")?.asked;
    return otro ? { ok: false, taken: otro } : { ok: true };
  }
  await publishToAudience(ns, msg, { t: "message:body", id: msgId, body: next });
  return {
    ok: true,
    undo: async () => {
      if (await db.swapMessageBody(msgId, next, body)) {
        await publishToAudience(ns, msg, { t: "message:body", id: msgId, body });
      }
    },
  };
}

/**
 * La alerta no tiene endpoint de acción —el clic manda al canal el `send` como mensaje de una
 * persona—, así que el reclamo va aparte y ANTES: si alguien ya pidió el fix, el cliente no
 * manda nada y pinta lo que pidió el otro.
 */
export const claimAlertFn = createServerFn({ method: "POST" })
  .validator((d: { msgId: number; send: string }) => d)
  .handler(async ({ data }) => {
    const r = await claimMessageCard(await sessionUser(), Number(data.msgId), "alert", String(data.send ?? ""));
    return r.ok ? { ok: true as const } : { ok: false as const, taken: r.taken };
  });

/**
 * La tarjeta de opciones (ask-user) es un ARTEFACTO, no un fence: su respuesta se escribe en el
 * `md` de la fila (ver `parseAskUserMd`) y se avisa con `refresh`, que es como llegó la tarjeta.
 * "Descartar" sigue siendo local: es una preferencia de vista de cada quien, no una respuesta.
 */
export const claimAskUserFn = createServerFn({ method: "POST" })
  .validator((d: { artifactId: number; answer: string }) => d)
  .handler(async ({ data }) => {
    const user = await sessionUser();
    if (!user) throw new Error("sesión requerida");
    const db = await import("../db.server");
    const art = await db.getArtifactRow(Number(data.artifactId));
    if (!art || art.kind !== "ask-user") throw new Error("pregunta no encontrada");
    const msg = await db.getMessage(art.messageId);
    if (!msg || !(await threadVisibleFor(msg, { sub: user.sub, isOwner: !!user.isOwner }, db))) {
      throw new Error("pregunta no encontrada");
    }
    const cur = parseAskUserMd(art.md);
    if (cur.answered) return { ok: false as const, taken: cur.answered };
    const answer = String(data.answer ?? "");
    if (!cur.options.includes(answer)) throw new Error("opción inválida");
    const next = JSON.stringify({ options: cur.options, answered: answer });
    if (!(await db.swapArtifactMd(art.id, art.md, next))) {
      const otro = parseAskUserMd((await db.getArtifactRow(art.id))?.md).answered;
      return otro ? { ok: false as const, taken: otro } : { ok: true as const };
    }
    const { currentNamespace } = await import("./tenant.server");
    await publishToAudience(await currentNamespace(), msg, {
      t: "refresh",
      channelId: msg.dm_id != null ? null : msg.channel_id,
      parentId: msg.parent_id,
      dmId: msg.dm_id ?? null,
    });
    return { ok: true as const };
  });
