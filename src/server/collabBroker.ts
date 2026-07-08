import * as Y from "yjs";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import WebSocket from "ws";
import { BlockNoteSchema } from "@blocknote/core";
import { withMultiColumn } from "@blocknote/xl-multi-column";
import { ServerBlockNoteEditor } from "@blocknote/server-util";

// Broker: peer server-side que aplica los edits del AGENTE al MISMO Y.Doc que el usuario
// ve en vivo en el editor nativo. Se conecta al sync server (sidecar :9400) como un
// HocuspocusProvider más, con el mismo share token, y usa ServerBlockNoteEditor (headless,
// maneja el DOM internamente — `tryParseMarkdownToBlocks` lo necesita en Node) para
// convertir el markdown del agente a bloques y escribirlos al fragment "document-store".
//
// Stage 2 (CREAR): el stream ```eb-doc``` del agente se re-parsea por tick y reemplaza el
// fragment → el usuario ve el documento redactarse EN VIVO en el editor real (no la hoja
// Markdown falsa). Co-edición concurrente + quirúrgico con marks = Stage 3.

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
  const socket = new HocuspocusProviderWebsocket({ url: opts.wsUrl, WebSocketPolyfill: WebSocket });
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name: opts.room,
    token: opts.token,
    document: ydoc,
  });
  const server = ServerBlockNoteEditor.create({ schema } as never);

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
      const blocks = await server.tryParseMarkdownToBlocks(md);
      if (!blocks.length) return;
      // Una transacción → un solo update por tick a los clientes.
      ydoc.transact(() => server.blocksToYXmlFragment(blocks as never, frag()));
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
