import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteSchema } from "@blocknote/core";
import { en as blockNoteEn } from "@blocknote/core/locales";
import { withMultiColumn, multiColumnDropCursor, locales as multiColumnLocales } from "@blocknote/xl-multi-column";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";

// Editor colaborativo NATIVO del artefacto de GTeams (antes: iframe servido por
// EasyBits). BlockNote (block-based estilo Notion sobre ProseMirror) + colaboración
// Yjs nativa. Se carga LAZY (client-only) para no cargar su bundle pesado hasta que
// se abre un doc, ni romper el SSR de la ruta. Espejo de easybits
// CollabBlockNoteEditor.tsx pero: clases Tailwind neutrales (sin tokens de EasyBits) y
// persistencia del snapshot HTML vía `persistUrl` (una ruta proxy de GTeams → EasyBits,
// server-to-server, para no chocar con CORS al escribir Landing.sections cross-origin).

const COLORS = ["#e11d48", "#7c3aed", "#0891b2", "#16a34a", "#ea580c", "#db2777"];

// Envuelve el HTML del editor en un <section> de página para que el pipeline de
// PDF/export lo trate como documento en flujo (como Word), no prosa pelada. Mismo
// marcador `data-doc-flow` que usa EasyBits.
function wrapAsPage(innerHtml: string): string {
  return `<section data-doc-flow="1" class="w-[8.5in] min-h-[11in] p-16 leading-relaxed">${innerHtml}</section>`;
}

export default function CollabEditor({
  wsUrl,
  room,
  token,
  initialHtml,
  onSnapshot,
  editable,
}: {
  wsUrl: string;
  room: string;
  token: string;
  initialHtml: string;
  /** Snapshot HTML (envuelto en <section>) → el padre lo persiste a EasyBits vía server fn. */
  onSnapshot: (html: string) => void;
  editable: boolean;
}) {
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const seeded = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const ydoc = useMemo(() => new Y.Doc(), []);
  const provider = useMemo(
    () => new HocuspocusProvider({ url: wsUrl, name: room, token, document: ydoc }),
    [wsUrl, room, token, ydoc],
  );
  const user = useMemo(
    () => ({ name: "Editor", color: COLORS[Math.floor(Math.random() * COLORS.length)] }),
    [],
  );

  const editor = useCreateBlockNote(
    {
      schema: withMultiColumn(BlockNoteSchema.create()),
      dropCursor: multiColumnDropCursor,
      dictionary: { ...blockNoteEn, multi_column: multiColumnLocales.en },
      collaboration: {
        fragment: ydoc.getXmlFragment("document-store"),
        user,
        provider: { awareness: provider.awareness ?? undefined },
        showCursorLabels: "activity",
      },
    },
    [provider],
  );

  // Snapshot HTML → Landing.sections (debounced). El padre lo manda a EasyBits (server fn).
  const persist = useCallback(
    (innerHtml: string) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => onSnapshot(wrapAsPage(innerHtml)), 800);
    },
    [onSnapshot],
  );

  useEffect(() => {
    const onStatus = (e: { status: string }) =>
      setStatus(e.status === "connected" ? "connected" : e.status === "connecting" ? "connecting" : "disconnected");
    provider.on("status", onStatus);
    return () => {
      provider.off("status", onStatus);
    };
  }, [provider]);

  // Siembra desde el HTML inicial una sola vez si el Y.Doc está vacío (primer editor).
  useEffect(() => {
    if (!editor || !editable) return;
    const onSynced = async () => {
      if (seeded.current) return;
      const doc = editor.document;
      const isEmpty =
        doc.length <= 1 && (!doc[0] || (doc[0] as { content?: unknown[] }).content?.length === 0);
      if (isEmpty && initialHtml.trim()) {
        seeded.current = true;
        const blocks = await editor.tryParseHTMLToBlocks(initialHtml);
        if (blocks.length) editor.replaceBlocks(editor.document, blocks);
      }
    };
    provider.on("synced", onSynced);
    return () => {
      provider.off("synced", onSynced);
    };
  }, [provider, editor, initialHtml, editable]);

  // Persiste en cada cambio.
  useEffect(() => {
    if (!editor || !editable) return;
    return editor.onChange(async () => {
      const html = await editor.blocksToFullHTML(editor.document);
      persist(html);
    });
  }, [editor, editable, persist]);

  useEffect(
    () => () => {
      provider.destroy();
      ydoc.destroy();
    },
    [provider, ydoc],
  );

  return (
    <div className="flex h-full flex-col bg-[#f3f3f5]">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-neutral-200 bg-white/90 px-4 py-2 backdrop-blur">
        <span
          className={`inline-block size-2 rounded-full ${
            status === "connected" ? "bg-green-500" : status === "connecting" ? "bg-amber-400" : "bg-red-500"
          }`}
        />
        <span className="text-xs font-medium text-neutral-500">
          {status === "connected" ? "Co-edición en vivo" : status === "connecting" ? "Conectando…" : "Desconectado"}
          {!editable && " · solo lectura"}
        </span>
      </header>
      <div className="flex-1 overflow-auto px-4 py-8">
        <div className="mx-auto max-w-[820px]">
          <div className="min-h-[600px] rounded-md bg-white px-6 py-12 shadow-[0_1px_2px_rgba(0,0,0,0.06),0_12px_32px_-12px_rgba(0,0,0,0.18)] ring-1 ring-neutral-200/70 sm:px-14">
            <BlockNoteView editor={editor} editable={editable} theme="light" />
          </div>
        </div>
      </div>
    </div>
  );
}
