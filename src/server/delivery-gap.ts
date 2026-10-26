// ── El entregable prometido que no viajó ────────────────────────────────────────
//
// El agente cierra un turno con «Aquí está la etiqueta:» y el mensaje no lleva NADA:
// ni imagen, ni enlace, ni artefacto. Pasó en producción el 2026-08-24 — generó el
// `image.png` dentro de su caja, no lo publicó (así que nunca tuvo URL que poner) y lo
// entregó igual, rematando con «si sigues sin verla, dime en qué te aparece vacío»:
// le echó la culpa a la pantalla. La persona lo reportó tres veces como que el chat no
// enseña imágenes.
//
// El fallo es MUDO en los dos extremos, que es lo que lo hace caro: el turno cierra en
// verde, el modelo cree que entregó y nadie mira si lo prometido va adjunto. Dentro de un
// `eb-doc` ese hueco ya se avisa (`imageGapNotice`); en un mensaje normal de chat no había
// nada.
//
// ⚠️ Esto NO adivina si el trabajo estuvo bien. Sólo comprueba una contradicción dura:
// el texto anuncia algo que se mira, y en el mensaje no hay nada que mirar.

import { announcesMissingDelivery } from "@ghostystudio/computer";

/**
 * La marca del aviso en el cuerpo del mensaje. Es lo que `deliveryGapHint` busca al turno
 * siguiente, así que detección y búsqueda salen de la MISMA constante: con dos literales
 * sueltos, retocar el copy apagaría el hint sin que nada fallara.
 */
export const GAP_MARK = "⚠️ Este mensaje anuncia un archivo y no llegó ninguno.";

/**
 * El aviso, o "" si no hay contradicción.
 *
 * `tieneAdjunto` lo decide quien llama mirando la DB (artefactos del mensaje): un turno
 * puede entregar por tarjeta sin que el texto lleve una sola URL, y avisar ahí sería
 * decirle a la persona que falta algo que tiene delante.
 */
export function deliveryGapNotice(body: string, tieneAdjunto: boolean, reintento = false): string {
  // La detección es la pieza compartida (`@ghostystudio/computer`): la misma regla en WhatsApp.
  if (!announcesMissingDelivery(body, tieneAdjunto)) return "";
  // ⚠️ Esto lo lee LA PERSONA, no el agente. Hasta el 2026-08-31 decía «hay que publicarlo y
  // pegar la URL — una ruta dentro de la caja del agente (`image.png`, `/tmp/…`)», que es una
  // instrucción para el modelo puesta en la cara del usuario. Y funcionó como tal: el cliente
  // copió ese fragmento y lo mandó como su siguiente mensaje; el agente contestó «no entendí
  // tu mensaje». Un turno entero quemado por un aviso escrito para el lector equivocado.
  //
  // Ahora dice QUÉ pasó y QUÉ hacer, sin una sola ruta ni nada que invite a copiarse. La
  // instrucción técnica vive en `deliveryGapHint`, que sí va dirigida al agente.
  // Con reintento automático no se le pide nada a la persona: la plataforma ya le abrió al
  // agente un turno para entregarlo (descti, 4-oct: el aviso pedía repetir y nadie lo hizo).
  return reintento
    ? `${GAP_MARK} Ya se lo pedí otra vez al agente; en un momento lo entrega aquí.`
    : `${GAP_MARK} Se lo hice notar al agente: pídeselo de nuevo y debería entregarlo.`;
}

/** Prefijo de la clave del despertador que reintenta la entrega. Uno por burbuja, nunca encadenado. */
export const GAP_RETRY_PREFIX = "gap:";

/** Lo que el despertador del reintento le dice al agente (el `HUECO_HINT` llega aparte, solo). */
export const GAP_RETRY_TEXT =
  "🔁 La plataforma comprobó que tu respuesta anterior anunció un archivo que no llegó. " +
  "Entrégalo ahora, sin repetir lo que ya explicaste: una línea y el archivo.";

/** Con qué reabrir el turno del agente para que entregue lo que prometió. */
export type GapRetry = {
  ns: string;
  groupId: string;
  sub: string;
  dest: import("./connectors/tool-token.server").ToolDest;
  origin: string;
};

/**
 * Lo MISMO, dicho al AGENTE en el turno siguiente.
 *
 * Sin esto el aviso moría en la burbuja: el modelo no tenía forma de saber que su entrega no
 * viajó y seguía insistiendo. El 2026-08-31 repitió «está en la tarjeta de arriba» TRES veces
 * mientras el usuario le contestaba «no me aparece». No es que desobedeciera — es que nadie
 * se lo dijo.
 *
 * ⚠️ DERIVADO del último mensaje del agente, no guardado. Mismo criterio que el bloque de
 * imágenes rotas de `artifactDocHint`: no hace falta columna nueva y **se apaga solo** — en
 * cuanto entrega de verdad, su mensaje nuevo no lleva la marca y el hint desaparece. El
 * mensaje viejo conserva su aviso a propósito: es el registro de lo que pasó.
 *
 * Se busca la MARCA en vez de re-evaluar `deliveryGapNotice` aquí: el veredicto ya se calculó
 * en el `finally` del turno, con el artefacto ya minteado. Recalcularlo con otro estado podría
 * decirle al agente lo contrario de lo que el usuario tiene delante en la burbuja, que es
 * justo la clase de fallo de dos capas decidiendo lo mismo por su cuenta.
 */
export function hayHuecoPrevio(lastAgentBody: string | null | undefined): boolean {
  return !!lastAgentBody?.includes(GAP_MARK);
}

/** Lo que se le dice AL AGENTE. Imperativo y accionable, al revés que la burbuja, que desde
 *  el 2026-08-31 habla sólo para la persona.
 *
 *  Las tres prohibiciones explícitas ("tarjeta", "recargue", "no afirmes que lo entregaste")
 *  son literalmente las tres salidas que tomó en el incidente. Un "publica el archivo" a secas
 *  ya se le había dicho en la skill y no bastó. */
const HUECO_HINT =
  "⚠️ TU RESPUESTA ANTERIOR PROMETIÓ UN ARCHIVO Y NO VIAJÓ NINGUNO. Lo comprobó el servidor: " +
  "en ese mensaje no iba ni imagen, ni enlace, ni tarjeta. La persona NO lo tiene, por mucho " +
  "que tú lo veas en tu caja — una ruta tuya (`salida.docx`, `/tmp/…`) no existe fuera de ella " +
  "ni se convierte en nada en el chat.\n" +
  "Antes de contestar otra cosa: publícalo con `publish()` de `/opt/gs-sdk/storage.mjs` y " +
  "entrégalo en un bloque ```eb-file con la URL que te devuelva. NO repitas que ya está " +
  "arriba, ni que está en la tarjeta, ni le pidas que recargue: el que falló fuiste tú.\n" +
  "Si el archivo ya no está en tu caja, vuelve a generarlo; si no puedes, DILO — no vuelvas a " +
  "anunciarlo como entregado.\n\n";

/**
 * El hint del turno siguiente, resuelto desde el `dest` del turno.
 *
 * Se deriva de `dest` y no se le pasa desde la ruta por lo mismo que `memoryHint(dest)` y
 * `buildRosterHint(dest)`: es la forma que ya tienen todos los hermanos en este archivo, y así
 * `chat.ts`/`dm.ts` no necesitan un solo cambio. Cuesta un `LIMIT 1` sobre columna indexada,
 * ruido al lado del `recentContext(…, 40)` que el turno ya paga.
 */
export async function deliveryGapHint(
  dest: { channelId?: number; dmId?: number; parentId?: number } | null | undefined,
): Promise<string> {
  const scope =
    dest?.dmId != null
      ? { dmId: dest.dmId }
      : dest?.channelId != null
        ? { channelId: dest.channelId, parentId: dest.parentId ?? null }
        : null;
  if (!scope) return "";
  const db = await import("../db.server");
  const body = await db.lastAgentBody(scope).catch(() => null);
  return hayHuecoPrevio(body) ? HUECO_HINT : "";
}


/**
 * Lo comprueba y, si falta, lo dice EN LA BURBUJA.
 *
 * Se llama al cerrar el turno, cuando el cuerpo ya está en su forma final (los `eb-doc`,
 * los patches y las tarjetas ya reescribieron el mensaje). Antes daría falsos positivos
 * sobre un texto que todavía no había pasado por su rama.
 *
 * Mismo criterio que `imageGapNotice`: lo que el servidor descubrió y el modelo no podía
 * saber, se dice en la burbuja. Y sólo hay segundo write cuando de verdad falta algo.
 */
export async function warnIfNothingDelivered(
  messageId: number,
  publish: (body: string) => void,
  retry?: GapRetry | null,
): Promise<void> {
  const db = await import("../db.server");
  const msg = await db.getMessage(messageId);
  if (!msg) return;
  const [conArtefacto] = await db.attachArtifacts([msg]);
  // ⚠️ Un ```eb-file se QUITA del cuerpo y viaja como adjunto (`gc_attachments`), no como
  // artefacto: sin mirar los adjuntos, todo .docx/.pdf entregado así salía con el aviso
  // falso y el turno siguiente se creía en falta (descti, 12-oct).
  const [conAdjunto] = await db.attachAttachments([msg]);
  // Las tools de @ads (y otras) hacen que la PLATAFORMA publique la tarjeta como mensaje
  // aparte, en el mismo hilo y durante el turno. «Ahí está la tarjeta» es verdad, pero este
  // mensaje no la lleva: se buscan tarjetas `gt-` publicadas después de la burbuja (26-sep).
  const { dbq } = await import("../dbq.server");
  const scope =
    msg.dm_id != null
      ? { sql: "dm_id = ?", arg: msg.dm_id }
      : msg.parent_id != null
        ? { sql: "parent_id = ?", arg: msg.parent_id }
        : { sql: "channel_id = ? AND (parent_id IS NULL OR also_in_channel = 1)", arg: msg.channel_id };
  const tarjetas = await dbq(
    `SELECT 1 FROM gc_messages WHERE ${scope.sql} AND id > ? AND body LIKE '%\`\`\`gt-%' LIMIT 1`,
    [scope.arg, messageId],
  ).catch(() => []);
  const entregado = !!conArtefacto?.artifact || !!conAdjunto?.attachments?.length || tarjetas.length > 0;
  if (!deliveryGapNotice(msg.body, entregado)) return;
  // Reintento automático: UN turno de seguimiento por burbuja (clave idempotente). Quien lo
  // corre (`wakeups.fire`) vuelve a llamar aquí SIN `retry`, así que no se encadena.
  let reintento = false;
  if (retry) {
    const { enqueueWakeup, mintWakeRef, kickWakeups } = await import("./wakeups.server");
    reintento = await enqueueWakeup({
      key: `${GAP_RETRY_PREFIX}${messageId}`,
      ref: mintWakeRef({ sub: retry.sub, ns: retry.ns, groupId: retry.groupId, dest: retry.dest }),
      cause: "entrega pendiente",
      text: GAP_RETRY_TEXT,
      origin: retry.origin,
      dueAt: Math.floor(Date.now() / 1000),
    }).catch(() => false);
    if (reintento) kickWakeups(retry.ns);
  }
  const aviso = deliveryGapNotice(msg.body, entregado, reintento);
  const body = `${msg.body}\n\n${aviso}`.trim();
  await db.setMessageBody(messageId, body);
  publish(body);
}
