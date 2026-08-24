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

/** Frases con las que un agente ANUNCIA que adjunta algo. Deliberadamente cortas y
 *  literales: una lista amplia daría falsos positivos sobre prosa normal, y un falso
 *  positivo aquí le dice a la persona que falta algo que sí está. */
// ⚠️ Sin `\b` al final: en JS es ASCII, así que después de una vocal acentuada («está»,
// «así») NO hay frontera de palabra y el patrón no casaba con el caso real que lo motivó.
// Se ve correcto y no dispara nunca — cazado por el test, no en producción.
const ANUNCIOS = [
  /aqu[ií] (?:est[aá]|tienes|va|te dejo|te la dejo|te lo dejo)/i,
  /(?:te )?(?:la|lo|las|los) (?:mando|env[ií]o|adjunto|dejo|comparto)/i,
  /(?:ya )?(?:qued[oó]|sali[oó]) (?:as[ií]|listo|lista)/i,
  /va como imagen/i,
  /est[aá] (?:lista|listo) (?:la|el)/i,
];

/** Lo que cuenta como que SÍ viajó algo: imagen markdown, enlace, o un fence nuestro
 *  (`eb-doc`, `gt-pr`, `eb-file`…) que la plataforma convierte en tarjeta. */
const LLEVA_ALGO = [
  /!\[[^\]]*\]\([^)]+\)/,          // imagen markdown
  /<img\b/i,                        // imagen HTML
  /\]\(https?:\/\//i,               // enlace markdown
  /https?:\/\/\S{8,}/i,             // URL suelta
  /```(?:gt|eb)-[a-z-]+/i,          // fence de la plataforma
];

/**
 * El aviso, o "" si no hay contradicción.
 *
 * `tieneAdjunto` lo decide quien llama mirando la DB (artefactos del mensaje): un turno
 * puede entregar por tarjeta sin que el texto lleve una sola URL, y avisar ahí sería
 * decirle a la persona que falta algo que tiene delante.
 */
export function deliveryGapNotice(body: string, tieneAdjunto: boolean): string {
  if (tieneAdjunto) return "";
  const texto = (body ?? "").trim();
  if (!texto) return "";
  // Los bloques de herramientas y pasos no son la respuesta: se quitan antes de buscar el
  // anuncio, o un `detail` con una URL contaría como entrega.
  const prosa = texto.replace(/```[\s\S]*?```/g, " ");
  if (!ANUNCIOS.some((re) => re.test(prosa))) return "";
  if (LLEVA_ALGO.some((re) => re.test(prosa))) return "";
  return (
    "⚠️ Este mensaje anuncia un archivo y no lleva ninguno. " +
    "Para que se vea hay que **publicarlo** y pegar la URL — una ruta dentro de la caja del " +
    "agente (`image.png`, `/tmp/…`) no existe fuera de ella."
  );
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
): Promise<void> {
  const db = await import("../db.server");
  const msg = await db.getMessage(messageId);
  if (!msg) return;
  const [conArtefacto] = await db.attachArtifacts([msg]);
  const aviso = deliveryGapNotice(msg.body, !!conArtefacto?.artifact);
  if (!aviso) return;
  const body = `${msg.body}\n\n${aviso}`.trim();
  await db.setMessageBody(messageId, body);
  publish(body);
}
