// Estado Yjs → bloques de BlockNote, en Node y sin navegador.
//
// Ojo con la distinción, que costó un spike: CONVERTIR un Y.Doc a bloques sí funciona
// server-side (`yXmlFragmentToBlocks` es pura lectura). Lo que NO funciona es EDITAR el
// Y.Doc desde el servidor: `ServerBlockNoteEditor` no queda ligado al fragment porque el
// plugin de y-prosemirror necesita un editor montado, y en Node no hay vista — sus
// escrituras se quedan en su documento interno (comprobado: el fragment quedaba en 0
// hijos). Por eso los cambios del agente los aplica el CLIENTE con `reconcile`, y aquí
// sólo se lee.
import * as Y from "yjs";
import type { DocBlock } from "../lib/doc-blocks";

const FRAGMENT = "document-store";

/** Bloques que representa un estado Yjs binario. `[]` si está vacío o no se puede leer. */
export async function bloquesDesdeEstadoY(state: Uint8Array): Promise<DocBlock[]> {
  try {
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, state);

    const { ServerBlockNoteEditor } = await import("@blocknote/server-util");
    const { BlockNoteSchema } = await import("@blocknote/core");
    const { withMultiColumn } = await import("@blocknote/xl-multi-column");
    const server = ServerBlockNoteEditor.create({
      schema: withMultiColumn(BlockNoteSchema.create()),
    } as never);

    const blocks = server.yXmlFragmentToBlocks(ydoc.getXmlFragment(FRAGMENT));
    ydoc.destroy();
    return (blocks ?? []) as unknown as DocBlock[];
  } catch (e) {
    // Nunca tumbar el cierre de sesión por esto: peor caso no se corta versión y el
    // estado sigue en `yUpdate`, que es recuperable.
    console.error("[collab] no se pudo leer el estado Yjs:", (e as Error).message);
    return [];
  }
}
