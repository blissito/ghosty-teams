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
import type { CollabUser } from "../server/collab";

// Presencia: un participante vivo en la sala (derivado del awareness de Hocuspocus).
type Peer = {
  clientId: number;
  name: string;
  color: string;
  avatar?: string;
  isAgent?: boolean;
  isSelf: boolean;
};

function initial(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase();
}

// Avatar de un participante: imagen si la hay, si no la inicial sobre su color.
function PeerAvatar({ peer }: { peer: Peer }) {
  return (
    <div
      title={`${peer.name}${peer.isSelf ? " (tú)" : ""}`}
      className="relative -ml-2 size-7 shrink-0 rounded-full ring-2 ring-white transition-transform duration-200 ease-out first:ml-0 hover:z-10 hover:-translate-y-0.5"
      style={{ backgroundColor: peer.color }}
    >
      {peer.avatar ? (
        <img
          src={peer.avatar}
          alt={peer.name}
          className="size-full rounded-full object-cover"
          referrerPolicy="no-referrer"
        />
      ) : (
        <span className="grid size-full place-items-center text-[11px] font-semibold text-white">
          {initial(peer.name)}
        </span>
      )}
      {/* Punto de estado: el agente se distingue por su anillo oscuro. */}
      <span
        className={`absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-white ${
          peer.isAgent ? "bg-neutral-900" : "bg-green-500"
        }`}
      />
    </div>
  );
}

// Fila de avatares apilados (estilo Tiptap Collaboration): overlap + "+N" al desbordar.
function PresenceRail({ peers }: { peers: Peer[] }) {
  const MAX = 5;
  const shown = peers.slice(0, MAX);
  const rest = peers.length - shown.length;
  return (
    <div className="flex items-center pl-2">
      {shown.map((p) => (
        <PeerAvatar key={p.clientId} peer={p} />
      ))}
      {rest > 0 && (
        <div
          title={peers.slice(MAX).map((p) => p.name).join(", ")}
          className="-ml-2 grid size-7 shrink-0 place-items-center rounded-full bg-neutral-200 text-[11px] font-semibold text-neutral-600 ring-2 ring-white"
        >
          +{rest}
        </div>
      )}
    </div>
  );
}

// Editor colaborativo NATIVO del artefacto de GTeams (antes: iframe servido por
// EasyBits). BlockNote (block-based estilo Notion sobre ProseMirror) + colaboración
// Yjs nativa. Se carga LAZY (client-only) para no cargar su bundle pesado hasta que
// se abre un doc, ni romper el SSR de la ruta. Espejo de easybits
// CollabBlockNoteEditor.tsx pero: clases Tailwind neutrales (sin tokens de EasyBits) y
// persistencia del snapshot HTML vía `persistUrl` (una ruta proxy de GTeams → EasyBits,
// server-to-server, para no chocar con CORS al escribir Landing.sections cross-origin).

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
  user,
}: {
  wsUrl: string;
  room: string;
  token: string;
  initialHtml: string;
  /** Identidad REAL del que edita (server-side, color estable por `sub`). */
  user: CollabUser;
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
  const [peers, setPeers] = useState<Peer[]>([]);

  // BlockNote sólo consume {name, color} para el caret; el resto viaja en el awareness
  // (lo lee el rail). Memo por identidad para no re-crear el editor en cada render.
  const cursorUser = useMemo(
    () => ({ name: user.name, color: user.color }),
    [user.name, user.color],
  );

  const editor = useCreateBlockNote(
    {
      schema: withMultiColumn(BlockNoteSchema.create()),
      dropCursor: multiColumnDropCursor,
      dictionary: { ...blockNoteEn, multi_column: multiColumnLocales.en },
      collaboration: {
        fragment: ydoc.getXmlFragment("document-store"),
        user: cursorUser,
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

  // Presencia: publica la identidad completa (BlockNote sólo pone {name,color}) y
  // escucha el awareness para pintar el rail de avatares.
  useEffect(() => {
    const awareness = provider.awareness;
    if (!awareness) return;
    const me = { name: user.name, color: user.color, avatar: user.avatar, sub: user.sub };

    const sync = () => {
      const local = awareness.getLocalState()?.user as { sub?: string } | undefined;
      // Re-afirma si y-prosemirror sobrescribió con el objeto pelado del caret.
      if (local?.sub !== user.sub) awareness.setLocalStateField("user", me);

      const next: Peer[] = [];
      awareness.getStates().forEach((state, clientId) => {
        const u = (state as { user?: Partial<Peer> & { avatar?: string } }).user;
        if (!u?.name) return;
        next.push({
          clientId,
          name: u.name,
          color: u.color || "#737373",
          avatar: u.avatar || undefined,
          isAgent: Boolean(u.isAgent),
          isSelf: clientId === awareness.clientID,
        });
      });
      // Orden estable: yo primero, luego el agente, luego el resto por clientId.
      next.sort((a, b) =>
        Number(b.isSelf) - Number(a.isSelf) || Number(b.isAgent) - Number(a.isAgent) || a.clientId - b.clientId,
      );
      setPeers(next);
    };

    sync();
    awareness.on("change", sync);
    return () => {
      awareness.off("change", sync);
    };
  }, [provider, user.name, user.color, user.avatar, user.sub]);

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
        <div className="ml-auto">
          <PresenceRail peers={peers} />
        </div>
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
