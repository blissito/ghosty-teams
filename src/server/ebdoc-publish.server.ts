// ── Publicar el ```eb-doc``` de una respuesta como artefacto (un solo camino) ──────────────
//
// Lo usan el turno de chat y el de despertador (relevos, programados, fábrica). Antes sólo lo
// hacía el chat: en un relevo de descti (19-oct, #1005) @astra cerró un ```eb-doc``` que nunca
// se publicó y la burbuja decía «Documento listo — ábrelo en el panel» sin nada que abrir.

export type CurrentDoc = Awaited<ReturnType<typeof import("../db.server").getDoc>> | null;

/**
 * Si `reply` trae un ```eb-doc``` cerrado, lo publica como versión del artefacto del hilo (o
 * documento nuevo) y devuelve la burbuja sin el fence (con el aviso de imágenes si faltó
 * alguna). `null` = no había documento que publicar.
 */
export async function publishEbDocFromReply(o: {
  messageId: number;
  reply: string;
  ownerSub: string | null;
  currentDocId: string | null;
  currentDoc: CurrentDoc;
  setPointer: (docId: string) => Promise<void>;
  notify: () => void;
  /** Se llama con la burbuja limpia ANTES de publicar, para no enseñar el fence mientras sube. */
  onCleaned?: (body: string) => Promise<void>;
}): Promise<string | null> {
  const { extractEbDoc, isSameDocument, draftTitle, bubbleWithoutEbDoc } = await import("../lib/ebdoc");
  const ebdoc = extractEbDoc(o.reply);
  if (!ebdoc?.closed || !ebdoc.md.trim()) return null;
  const cleaned = bubbleWithoutEbDoc(o.reply, undefined, { keepStatus: true });
  await o.onCleaned?.(cleaned);
  // ¿Versión del artefacto del hilo, o documento nuevo? Ver isSameDocument: antes se reusaba el
  // puntero SIEMPRE, así que todo lo que se pidiera después caía como versión de lo anterior.
  const { randomUUID } = await import("node:crypto");
  const documentId =
    o.currentDocId && isSameDocument(ebdoc, o.currentDoc) ? o.currentDocId : `${ebdoc.kind}_${randomUUID()}`;
  // Publicación por el camino ÚNICO (mismo que la edición humana del Canvas): siembra los
  // `data-id` del artefacto (dirección para el próximo ```eb-patch```), sube el HTML a storage
  // como enlace compartible, INSERTa la versión, apunta el hilo y refresca.
  const { publishArtifactVersion, imageGapNotice } = await import("./artifacts");
  const pub = await publishArtifactVersion({
    messageId: o.messageId,
    documentId,
    kind: ebdoc.kind, // "doc" | "sheet" | "artifact"
    title: draftTitle(ebdoc.md, ebdoc.kind, ebdoc.fenceTitle),
    md: ebdoc.md,
    // `undefined` cuando el agente no dijo nada, y eso NO es "con marca": es "lo que ya dijera
    // el documento". Re-emitir un oficio sin repetir la marca no debe devolverle el membrete.
    unbranded: ebdoc.unbranded,
    ownerSub: o.ownerSub,
    setPointer: o.setPointer,
    notify: o.notify,
  });
  const aviso = imageGapNotice(pub.imagesFailed);
  return aviso ? `${cleaned}\n\n${aviso}`.trim() : cleaned;
}
