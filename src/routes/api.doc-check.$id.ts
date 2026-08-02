import { createFileRoute } from "@tanstack/react-router";

// GET /api/doc-check/:id?v=<versionId>&lang=es
//   → NDJSON, un objeto por bloque: {id, hash, matches:[{offset,length,mensaje,…}]}
//
// La revisión ortográfica y gramatical del documento. Se pinta progresiva —cada línea que
// llega es un párrafo ya revisado— en vez de esperar a tener el documento entero: con 100
// bloques son un par de segundos y el usuario ve avanzar el contador.
//
// **Un bloque por petición a LanguageTool, no el documento entero**, y no por comodidad:
// así los offsets de cada hallazgo son LOCALES a su párrafo, y editar uno invalida sólo
// sus hallazgos. Con offsets globales, cualquier tecla tira el mapa completo. Es la misma
// decisión que en el audio: la unidad de la petición es la unidad del resaltado.
//
// El TEXTO lo saca el servidor del documento, no lo manda el cliente: si viniera en el
// cuerpo, esto sería un corrector abierto para cualquiera con sesión. El permiso y la
// versión son los mismos que los de la descarga y el audio (`resolveExportDoc`).
//
// Se recorre el árbol COMPLETO (no sólo el primer nivel): un elemento de lista o una celda
// de tabla también tienen faltas, y el resaltado los direcciona por id, no por índice.
export const Route = createFileRoute("/api/doc-check/$id")({
  server: {
    handlers: {
      GET: async ({ params, request }: { params: { id: string }; request: Request }) => {
        const url = new URL(request.url);

        const { sessionUser } = await import("../server/chat");
        const me = await sessionUser();

        const { resolveExportDoc, docBlocks } = await import("../server/doc-access.server");
        const doc = await resolveExportDoc(params.id, url.searchParams.get("v"), me);
        if (!doc) return new Response("not found", { status: 404 });
        if (doc.kind !== "doc") return new Response("not a document", { status: 400 });

        const { blockText } = await import("../lib/doc-blocks");
        const idioma = url.searchParams.get("lang") || "es";
        const blocks = await docBlocks(doc.md);

        // Aplana el árbol conservando el tipo de cada bloque: el tipo decide qué reglas
        // aplican (un título no lleva punto final).
        type Plano = { id: string; texto: string; esParrafo: boolean };
        const planos: Plano[] = [];
        const recorrer = (list: unknown[]) => {
          for (const raw of list) {
            const b = raw as { id?: string; type?: string; children?: unknown[] };
            const texto = blockText(b as never).trim();
            if (b.id && texto) {
              planos.push({ id: b.id, texto, esParrafo: (b.type || "paragraph") === "paragraph" });
            }
            if (b.children?.length) recorrer(b.children);
          }
        };
        recorrer(blocks);

        const { revisar } = await import("../server/languagetool.server");
        const { firmaTexto } = await import("../lib/doc-firma");

        // Concurrencia moderada. LanguageTool SÍ escala (medido: 3 peticiones en paralelo
        // tardan lo mismo que una), pero no hay razón para inundar la caja: con 66 ms por
        // párrafo, cuatro a la vez ya dejan la revisión en un par de segundos.
        const CONCURRENCIA = 4;

        const stream = new ReadableStream({
          async start(controller) {
            const enc = new TextEncoder();
            let i = 0;
            const linea = (o: unknown) => controller.enqueue(enc.encode(`${JSON.stringify(o)}\n`));
            linea({ total: planos.length });

            const obrero = async () => {
              while (i < planos.length) {
                const p = planos[i++];
                const matches = await revisar(p.texto, { idioma, esParrafo: p.esParrafo });
                // `null` = el servicio falló. Se dice, no se calla: el cliente lo cuenta y
                // avisa de que la revisión está incompleta en vez de dar por bueno un
                // documento que nadie revisó.
                linea(
                  matches
                    ? { id: p.id, hash: firmaTexto(p.texto), matches }
                    : { id: p.id, error: true },
                );
              }
            };
            await Promise.all(Array.from({ length: CONCURRENCIA }, obrero));
            controller.close();
          },
        });

        return new Response(stream, {
          status: 200,
          headers: {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            // El contenido de un documento privado no se cachea en ningún intermediario.
            "Cache-Control": "private, no-store",
          },
        });
      },
    },
  },
});
