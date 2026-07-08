import * as Y from "yjs";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import WebSocket from "ws";
import { BlockNoteEditor, BlockNoteSchema } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import { withMultiColumn } from "@blocknote/xl-multi-column";

// Broker: peer server-side que aplica los edits del AGENTE al MISMO Y.Doc que el usuario
// ve en vivo en el editor nativo. Se conecta al sync server (sidecar :9400 vía loopback,
// o el box) como un HocuspocusProvider más, con el mismo share token. Usa un editor
// BlockNote HEADLESS (Node plano, sin DOM — probado en el spike) sólo para convertir
// markdown → bloques y escribirlos al fragment compartido "document-store".
//
// Hoy (Stage 2, CREAR): el stream ```eb-doc``` del agente se re-parsea completo por tick
// y reemplaza el fragment → el usuario ve el documento redactarse EN VIVO en el editor
// real (no la hoja Markdown falsa). La co-edición concurrente humano↔agente (marks
// accept/reject + posiciones relativas) es Stage 3.

const FRAGMENT = "document-store";
const schema = withMultiColumn(BlockNoteSchema.create());

export type DocBroker = {
  /** Re-parsea el markdown acumulado del agente y lo escribe al Y.Doc (streaming, por tick). */
  applyMarkdown(md: string): Promise<void>;
  close(): void;
};

// Abre un broker contra el sync server y espera el primer sync. `timeoutMs` acota la
// espera (si el sidecar no responde, el caller cae al camino viejo sin colgar el turno).
export async function openDocBroker(opts: {
  wsUrl: string;
  room: string;
  token: string;
  timeoutMs?: number;
}): Promise<DocBroker> {
  const ydoc = new Y.Doc();
  // En Node el WebSocket se inyecta vía HocuspocusProviderWebsocket (WebSocketPolyfill).
  const socket = new HocuspocusProviderWebsocket({ url: opts.wsUrl, WebSocketPolyfill: WebSocket });
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name: opts.room,
    token: opts.token,
    document: ydoc,
  });
  // Editor headless sólo presta su schema a las utils Yjs (no se monta en DOM).
  const editor = BlockNoteEditor.create({ schema } as never) as {
    tryParseMarkdownToBlocks: (md: string) => Promise<unknown[]>;
  };

  await new Promise<void>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("collab sync timeout")), opts.timeoutMs ?? 15000);
    const done = () => {
      clearTimeout(to);
      resolve();
    };
    if (provider.isSynced) done();
    else provider.on("synced", done);
  });

  const frag = () => ydoc.getXmlFragment(FRAGMENT);
  return {
    async applyMarkdown(md: string) {
      if (!md.trim()) return;
      const blocks = await editor.tryParseMarkdownToBlocks(md);
      if (!blocks.length) return;
      // Una transacción → un solo update por tick a los clientes.
      ydoc.transact(() => blocksToYXmlFragment(editor as never, blocks as never, frag()));
    },
    close() {
      try {
        provider.destroy();
        socket.destroy();
      } catch {
        /* ya cerrado */
      }
      ydoc.destroy();
    },
  };
}
