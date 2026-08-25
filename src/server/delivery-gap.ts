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

/** Los anuncios que por sí solos NO prueban nada, porque en español son marcador de
 *  discurso antes que entrega. «Aquí va el panorama», «aquí está el resumen» y «aquí
 *  tienes la comparación» introducen texto que viene a continuación, no un archivo.
 *
 *  ⚠️ Esto se descubrió en producción el 2026-08-25, en el PRIMER mensaje que un cliente
 *  nuevo vio del producto: una respuesta de puro texto rematada con «anuncia un archivo y
 *  no lleva ninguno». El aviso existe para cerrar un hueco mudo; disparado en falso hace
 *  justo lo contrario — le dice a la persona que le falta algo que nunca hubo. */
const AMBIGUOS = [0, 4];

/** Lo que hay que mirar o abrir: un archivo, no un párrafo. Un anuncio ambiguo sólo cuenta
 *  si nombra uno de éstos cerca.
 *
 *  Es una ALLOWLIST a propósito, y por eso deja fuera «reporte», «informe» y «análisis»:
 *  esos se entregan como prosa en el chat la mayoría de las veces, y el modo de falla
 *  tolerable aquí es callarse de más, nunca avisar de menos. Ver la nota de arriba. */
const ENTREGABLE =
  /\b(archivo|imagen|im[aá]genes|foto|fotos|captura|gr[aá]fica|gr[aá]fico|diagrama|tabla|hoja|documento|etiqueta|logo|portada|banner|cartel|cat[aá]logo|presentaci[oó]n|cotizaci[oó]n|factura|video|audio|nota de voz|liga|enlace|link|pdf|docx?|xlsx?|pptx?|png|jpe?g|svg|zip|csv)\b/i;

/** Ventana en la que se busca el entregable después del anuncio. «Aquí está de nuevo la
 *  etiqueta» mete tres palabras en medio, así que la adyacencia no sirve. */
const VENTANA = 60;

/** Lo que cuenta como que SÍ viajó algo: imagen markdown, enlace, o un fence nuestro
 *  (`eb-doc`, `gt-pr`, `eb-file`…) que la plataforma convierte en tarjeta. */
const LLEVA_ALGO = [
  /!\[[^\]]*\]\([^)]+\)/,          // imagen markdown
  /<img\b/i,                        // imagen HTML
  /\]\(https?:\/\//i,               // enlace markdown
  /https?:\/\/\S{8,}/i,             // URL suelta
  /```(?:gt|eb)-[a-z-]+/i,          // fence de la plataforma
];

/** ¿Este patrón, en este texto, anuncia de verdad una entrega? Los ambiguos exigen además
 *  que se nombre un entregable en la ventana siguiente. */
function anuncia(re: RegExp, i: number, prosa: string): boolean {
  const m = re.exec(prosa);
  if (!m) return false;
  if (!AMBIGUOS.includes(i)) return true;
  return ENTREGABLE.test(prosa.slice(m.index, m.index + m[0].length + VENTANA));
}

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
  if (!ANUNCIOS.some((re, i) => anuncia(re, i, prosa))) return "";
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
