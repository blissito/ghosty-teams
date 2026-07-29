import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { useCallback, useEffect, useRef } from "react";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteSchema } from "@blocknote/core";
import { en as blockNoteEn } from "@blocknote/core/locales";
import {
  withMultiColumn,
  multiColumnDropCursor,
  locales as multiColumnLocales,
} from "@blocknote/xl-multi-column";
import { blockSignature, type DocBlock } from "../lib/doc-blocks";

// ── El editor de documentos de texto ──────────────────────────────────────────
//
// BlockNote (bloques estilo Notion sobre ProseMirror). Antes un `eb-doc` se pintaba
// como markdown renderizado en una hoja blanca: bonito, pero muerto — no se podía
// tocar. Ahora el documento se REDACTA dentro del editor real y queda editable en
// cuanto el agente suelta el turno.
//
// Este archivo es `CollabEditor.tsx` nativizado: se le quitaron HocuspocusProvider,
// el `collaboration:{}`, la siembra por HTML y la persistencia a Landing.sections de
// EasyBits. La co-edición vuelve como un prop `collab?` opcional cuando exista el
// sync server; el modelo de datos (bloques con uuid) ya está listo para eso.
//
// Se carga LAZY desde DocSurface: BlockNote + Mantine son pesados y no deben entrar
// al bundle inicial del chat.

const schema = withMultiColumn(BlockNoteSchema.create());
const dictionary = { ...blockNoteEn, multi_column: multiColumnLocales.en };

/**
 * Deja intacto el prefijo que no cambió y reemplaza sólo la cola.
 *
 * Es el corazón anti-parpadeo. Durante el streaming el markdown se re-parsea en cada
 * tick, y `tryParseMarkdownToBlocks` acuña uuids NUEVOS cada vez: si se reemplazara
 * el documento completo, cada tick remontaría todos los bloques y el resultado es
 * parpadeo, scroll al principio y (cuando sea editable) cursor perdido. Comparando
 * por CONTENIDO — `blockSignature`, que ignora el id a propósito — el prefijo estable
 * se reconoce y se conserva, y con él sus ids.
 *
 * El markdown en streaming crece por la cola, así que en la práctica esto toca un
 * solo bloque por tick.
 */
function reconcile(
  editor: {
    document: unknown;
    replaceBlocks: (a: unknown, b: unknown) => void;
    insertBlocks: (a: unknown, b: unknown, c: string) => void;
    removeBlocks: (a: unknown) => void;
  },
  next: DocBlock[],
): void {
  const cur = (editor.document ?? []) as DocBlock[];
  if (!next.length) return; // nunca vaciamos el documento por un tick raro

  let i = 0;
  const min = Math.min(cur.length, next.length);
  while (i < min && blockSignature(cur[i]) === blockSignature(next[i])) i++;

  // Idéntico: no tocar el editor. Sin esta salida, un tick sin cambios (el agente
  // escribiendo dentro del mismo bloque, o un repaint del body) haría trabajo de DOM
  // y movería el cursor por nada.
  if (i === cur.length && i === next.length) return;

  const tail = cur.slice(i);
  const newTail = next.slice(i);
  try {
    if (!tail.length) {
      // Sólo creció: insertar después del último bloque que sí coincidió.
      editor.insertBlocks(newTail, cur[i - 1], "after");
    } else if (!newTail.length) {
      editor.removeBlocks(tail);
    } else {
      editor.replaceBlocks(tail, newTail);
    }
  } catch {
    // Un splice inválido (bloque que ya no está, esquema inesperado) no puede dejar
    // el documento a medias: se reemplaza todo. Cuesta un remonte, que es justo lo
    // que este reconciliador evita en el camino normal.
    try {
      editor.replaceBlocks(cur, next);
    } catch {
      /* el editor se está desmontando */
    }
  }
}

export default function DocEditor({
  blocks,
  markdown,
  editable,
  streaming,
  onChange,
}: {
  /** La verdad, ya en bloques (documento publicado con sobre `v:1`). */
  blocks?: DocBlock[];
  /**
   * Markdown a convertir aquí dentro: es el caso del STREAMING (el agente escribe
   * markdown en el fence) y de las filas legacy anteriores al sobre. La conversión
   * vive en este componente porque `tryParseMarkdownToBlocks` es un método del
   * editor — hacerla fuera exigiría un segundo editor headless sólo para parsear.
   */
  markdown?: string;
  editable: boolean;
  /** El agente está escribiendo: mostramos el pulso y no dejamos editar. */
  streaming: boolean;
  /** Cambios hechos por una PERSONA (no los del reconciliador). */
  onChange?: (blocks: DocBlock[]) => void;
}) {
  const editor = useCreateBlockNote({
    schema,
    dropCursor: multiColumnDropCursor,
    dictionary,
    // Sólo se lee en el primer render; de ahí en adelante manda `reconcile`.
    initialContent: blocks?.length ? (blocks as never) : undefined,
  });

  // El reconciliador escribe en el editor y eso dispara onChange. Sin esta bandera
  // cada tick del agente se reportaría como edición humana: autosave en bucle y
  // `humanEdited` en true sin que nadie haya tocado nada.
  const applying = useRef(false);
  const seen = useRef<string>("");

  useEffect(() => {
    if (!editor) return;

    // Ojo: en el editor del CLIENTE `tryParseMarkdownToBlocks` es SINCRÓNICO (el
    // headless del server, `ServerBlockNoteEditor`, sí devuelve promesa). Al ser
    // sincrónico no hay parseos que resuelvan fuera de orden, así que no hace falta
    // guardar generaciones.
    let next: DocBlock[];
    if (blocks?.length) {
      next = blocks;
    } else if (markdown?.trim()) {
      try {
        next = editor.tryParseMarkdownToBlocks(markdown) as DocBlock[];
      } catch {
        return; // markdown a medias en pleno stream: el próximo tick lo arregla
      }
    } else {
      return;
    }
    if (!next.length) return;

    // Firma del documento entrante: si no cambió, no hay nada que hacer. El body del
    // turno se re-emite COMPLETO por tick, no sólo cuando el documento cambia.
    const sig = next.map(blockSignature).join(" ");
    if (sig === seen.current) return;
    seen.current = sig;
    applying.current = true;
    try {
      reconcile(editor as never, next);
    } finally {
      // Se libera en microtask: las transacciones de ProseMirror notifican onChange
      // sincrónicamente, pero el editor puede encolar pasos derivados.
      queueMicrotask(() => {
        applying.current = false;
      });
    }
  }, [editor, blocks, markdown]);

  const notify = useCallback(() => {
    if (applying.current || !onChange) return;
    onChange(editor.document as DocBlock[]);
  }, [editor, onChange]);

  useEffect(() => {
    if (!editor || !editable) return;
    return editor.onChange(notify);
  }, [editor, editable, notify]);

  const live = editable && !streaming;

  return (
    // `gt-doc` acota el CSS de Mantine: BlockNote trae estilos globales y el panel
    // vive en tema oscuro. Todo lo del editor queda dentro de esta clase.
    <div className="gt-doc min-h-0 flex-1 overflow-auto bg-surface-3 p-4 thin-scroll sm:p-6">
      <div className="mx-auto max-w-[8.5in]">
        <article className="min-h-[60vh] rounded-sm bg-white py-10 text-black shadow-md sm:py-14">
          <BlockNoteView
            editor={editor}
            editable={live}
            theme="light"
            // El menú de formato y el de slash sólo estorban mientras el agente
            // escribe (y ahí el documento no es editable de todos modos).
            formattingToolbar={live}
            slashMenu={live}
          />
          {streaming ? (
            <span className="ml-14 inline-block h-4 w-[3px] animate-pulse bg-brand align-text-bottom" />
          ) : null}
        </article>
      </div>
    </div>
  );
}
