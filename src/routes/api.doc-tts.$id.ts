import { createFileRoute } from "@tanstack/react-router";

// GET /api/doc-tts/:id?v=<versionId>&i=<índice de bloque>&s=<frase>&voice=em_santa
//   → el audio de ESE trozo (wav), con `X-Duration-Ms` y `X-Seg-Count`.
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
//
// ── `s`: la petición se parte en FRASES, el resaltado no ─────────────────────
//
// Un bloque entero cuesta demasiado en llegar (~16 ms/char: 6.4 s para un párrafo de 390
// caracteres, mirando un botón que no hace nada). Con `s` se pide UNA frase —la primera
// son ~1.6 s— y el resto se sintetiza mientras suena, que sobra porque la síntesis va 4×
// más rápida que la reproducción. Sin `s` se sigue devolviendo el bloque completo: es el
// contrato viejo y no cuesta nada mantenerlo.
//
// **`X-Seg-Count` es la autoridad del corte.** El cliente parte con el mismo módulo
// (`lib/tts-split`) para adivinar qué pedir después, pero si su copia del documento no es
// la del servidor —una edición sin guardar— sus índices bailan. Devolviendo la cuenta en
// cada respuesta, el cliente reconcilia su cola sin ruido, y un `s` de más contesta 404,
// que para él significa "este bloque se acabó", no un error.
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
        if (!texto) {
          return new Response(null, { status: 204, headers: { "X-Seg-Count": "0" } });
        }

        const { partirEnFrases } = await import("../lib/tts-split");
        const segs = partirEnFrases(texto);
        const sRaw = url.searchParams.get("s");
        let hablado = texto;
        if (sRaw !== null) {
          const s = Number(sRaw);
          if (!Number.isInteger(s) || s < 0) return new Response("bad segment", { status: 400 });
          if (s >= segs.length) {
            return new Response("no such segment", {
              status: 404,
              headers: { "X-Seg-Count": String(segs.length) },
            });
          }
          hablado = segs[s];
        }

        const { hablar, esVoz, VOZ_DEFAULT } = await import("../server/tts.server");
        const voz = url.searchParams.get("voice");
        const audio = await hablar(hablado, esVoz(voz) ? voz : VOZ_DEFAULT);
        if (!audio) return new Response("voice unavailable", { status: 502 });

        return new Response(new Uint8Array(audio.bytes), {
          status: 200,
          headers: {
            "Content-Type": audio.contentType,
            "X-Duration-Ms": String(audio.durMs),
            "X-Seg-Count": String(segs.length),
            "X-Seg-Index": sRaw === null ? "" : String(Number(sRaw)),
            // `private`: un documento puede ser un expediente y esto es su contenido leído
            // en voz alta. El caché de verdad vive en el servidor, llaveado por contenido.
            "Cache-Control": "private, max-age=300",
          },
        });
      },
    },
  },
});
