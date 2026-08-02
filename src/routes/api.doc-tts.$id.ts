import { createFileRoute } from "@tanstack/react-router";

// GET /api/doc-tts/:id?v=<versionId>&i=<índice de bloque>&voice=em_santa
//   → el audio de ESE bloque (wav), con `X-Duration-Ms`.
//
// Es el motor del "leer en voz alta" del documento (lo pidió un cliente durante el demo
// del 30-jul: leerlo como Word, siguiendo el texto con la vista). Un audio por BLOQUE, no
// uno del documento entero, por dos razones:
//
//  1. El resaltado va párrafo a párrafo, y kokoro sólo devuelve la duración TOTAL — no
//     hay timestamps con los que partir un audio largo. La unidad del audio ES la unidad
//     del resaltado.
//  2. El play arranca con el primer bloque en vez de esperar a que se sintetice todo.
//
// El TEXTO lo saca el servidor del documento, no lo manda el cliente: si viniera en el
// cuerpo, esto sería un sintetizador abierto para cualquiera con sesión. El índice es el
// del bloque de PRIMER NIVEL, que es la misma unidad que indexa el resaltado del editor
// (`marcarIndices` va contra `editor.document`), así que los dos lados coinciden sin
// pasarse ids.
//
// El permiso y la versión son los mismos que los de la descarga (`resolveExportDoc`): el
// audio de un documento es el documento.
export const Route = createFileRoute("/api/doc-tts/$id")({
  server: {
    handlers: {
      GET: async ({ params, request }: { params: { id: string }; request: Request }) => {
        const url = new URL(request.url);
        const i = Number(url.searchParams.get("i"));
        if (!Number.isInteger(i) || i < 0) return new Response("bad index", { status: 400 });

        const { sessionUser } = await import("../server/chat");
        const me = await sessionUser();

        const { resolveExportDoc, docBlocks } = await import("../server/doc-access.server");
        const doc = await resolveExportDoc(params.id, url.searchParams.get("v"), me);
        if (!doc) return new Response("not found", { status: 404 });
        if (doc.kind !== "doc") return new Response("not a document", { status: 400 });

        const { blockText } = await import("../lib/doc-blocks");
        const blocks = await docBlocks(doc.md);
        const b = blocks[i];
        if (!b) return new Response("no such block", { status: 404 });
        const texto = blockText(b).trim();
        // Un bloque sin texto (una imagen, un separador, un párrafo vacío) no es un error:
        // el cliente lo salta y sigue con el siguiente.
        if (!texto) return new Response(null, { status: 204 });

        const { hablar, esVoz, VOZ_DEFAULT } = await import("../server/tts.server");
        const voz = url.searchParams.get("voice");
        const audio = await hablar(texto, esVoz(voz) ? voz : VOZ_DEFAULT);
        if (!audio) return new Response("voice unavailable", { status: 502 });

        return new Response(new Uint8Array(audio.bytes), {
          status: 200,
          headers: {
            "Content-Type": audio.contentType,
            "X-Duration-Ms": String(audio.durMs),
            // `private`: un documento puede ser un expediente y esto es su contenido leído
            // en voz alta. El caché de verdad vive en el servidor, llaveado por contenido.
            "Cache-Control": "private, max-age=300",
          },
        });
      },
    },
  },
});
