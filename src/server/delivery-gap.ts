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
//
// ⚠️ «AHÍ» cuenta tanto como «aquí», y faltaba. Medido sobre el incidente del 2026-08-31
// (descti, DM 1): de los CUATRO mensajes que prometieron un .docx sin entregarlo, este
// patrón cazó UNO. Los otros tres decían «Ahí tienes el .docx», «Ahí va, en la tarjeta de
// arriba» — la forma que más usa el agente cuando cree que ya entregó, y la única que no
// estaba. La red de `AMBIGUOS` sigue cubriendo el falso positivo («Ahí va el panorama»).
const ANUNCIOS = [
  /(?:aqu[ií]|ah[ií]) (?:est[aá]|tienes|va|lo tienes|la tienes|te dejo|te la dejo|te lo dejo)/i,
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
 *  tolerable aquí es callarse de más, nunca avisar de menos. Ver la nota de arriba.
 *
 *  ⚠️ «tarjeta» entró el 2026-08-31 y no es un sustantivo cualquiera: es la palabra con la
 *  que el agente afirma en falso. «Ahí va, en la tarjeta de arriba» apunta a la tarjeta de
 *  descarga que la plataforma pinta — o sea, afirma algo COMPROBABLE sobre nuestra propia
 *  UI, y en ese caso la tarjeta no existía. */
const ENTREGABLE =
  /\b(archivo|imagen|im[aá]genes|foto|fotos|captura|gr[aá]fica|gr[aá]fico|diagrama|tabla|tarjeta|hoja|documento|etiqueta|logo|portada|banner|cartel|cat[aá]logo|presentaci[oó]n|cotizaci[oó]n|factura|video|audio|nota de voz|liga|enlace|link|pdf|docx?|xlsx?|pptx?|png|jpe?g|svg|zip|csv)\b/i;

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
export function deliveryGapNotice(body: string, tieneAdjunto: boolean): string {
  if (tieneAdjunto) return "";
  const texto = (body ?? "").trim();
  if (!texto) return "";
  // Los bloques de herramientas y pasos no son la respuesta: se quitan antes de buscar el
  // anuncio, o un `detail` con una URL contaría como entrega.
  const prosa = texto.replace(/```[\s\S]*?```/g, " ");
  if (!ANUNCIOS.some((re, i) => anuncia(re, i, prosa))) return "";
  if (LLEVA_ALGO.some((re) => re.test(prosa))) return "";
  // ⚠️ Esto lo lee LA PERSONA, no el agente. Hasta el 2026-08-31 decía «hay que publicarlo y
  // pegar la URL — una ruta dentro de la caja del agente (`image.png`, `/tmp/…`)», que es una
  // instrucción para el modelo puesta en la cara del usuario. Y funcionó como tal: el cliente
  // copió ese fragmento y lo mandó como su siguiente mensaje; el agente contestó «no entendí
  // tu mensaje». Un turno entero quemado por un aviso escrito para el lector equivocado.
  //
  // Ahora dice QUÉ pasó y QUÉ hacer, sin una sola ruta ni nada que invite a copiarse. La
  // instrucción técnica vive en `deliveryGapHint`, que sí va dirigida al agente.
  return `${GAP_MARK} Se lo hice notar al agente: pídeselo de nuevo y debería entregarlo.`;
}

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
