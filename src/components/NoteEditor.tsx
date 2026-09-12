import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { useEffect, useRef } from "react";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";

/**
 * Editor de una nota de la memoria: el MISMO BlockNote del documento (títulos, listas,
 * negritas con `/` y atajos), pero con markdown de entrada y de salida, que es como la
 * nota vive en la DB y como la lee el agente. Un `<textarea>` de cuatro renglones era
 * inservible para una nota con secciones —la guía de uso, un manual destilado—.
 *
 * `onMarkdown` se dispara en cada cambio con `blocksToMarkdownLossy`: la conversión es
 * barata a este tamaño (tope de la nota) y así el padre siempre tiene el texto listo para
 * guardar y para el contador.
 */
export default function NoteEditor({
  markdown,
  onMarkdown,
  placeholder,
}: {
  markdown: string;
  onMarkdown: (md: string) => void;
  placeholder?: string;
}) {
  const editor = useCreateBlockNote();
  const cargado = useRef(false);
  useEffect(() => {
    if (cargado.current) return;
    cargado.current = true;
    const blocks = markdown.trim() ? editor.tryParseMarkdownToBlocks(markdown) : [];
    if (blocks.length) editor.replaceBlocks(editor.document, blocks as never);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);
  return (
    <div
      className="gt-note-editor min-h-[12rem] max-h-[60vh] overflow-y-auto rounded-lg border border-border bg-surface-2 px-1 py-2 text-sm"
      data-placeholder={placeholder}
    >
      <BlockNoteView
        editor={editor}
        theme="dark"
        spellCheck={false}
        onChange={() => {
          // En el cliente `blocksToMarkdownLossy` es SINCRÓNICO (mismo caso que
          // `tryParseMarkdownToBlocks` en DocEditor); se envuelve por si un día vuelve promesa.
          void Promise.resolve(editor.blocksToMarkdownLossy()).then(onMarkdown);
        }}
      />
    </div>
  );
}
