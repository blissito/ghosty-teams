import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote, ThreadsSidebar } from "@blocknote/react";
import { BlockNoteSchema } from "@blocknote/core";
import {
  CommentsExtension,
  DefaultThreadStoreAuth,
  ThreadStoreAuth,
  YjsThreadStore,
} from "@blocknote/core/comments";
import { MessageSquare } from "lucide-react";
import { useT } from "../i18n";
import { en as blockNoteEn } from "@blocknote/core/locales";
import {
  withMultiColumn,
  multiColumnDropCursor,
  locales as multiColumnLocales,
} from "@blocknote/xl-multi-column";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import type { CollabUser } from "../server/collab";
import type { DocRole } from "../db.server";
import { resolveDocUsersFn, type DocUser } from "../server/doc-users";
import { parseDocEnvelope } from "../lib/doc-blocks";
import { reconcile, type ReconcilableEditor } from "../lib/doc-reconcile";

// Quien sólo puede VER no puede hacer NADA con los hilos. No es cosmético: su conexión
// entra `readOnly` en el sidecar, así que cualquier escritura se descartaría en silencio
// y la UI le mentiría ofreciéndole botones que no hacen nada.
class SoloLecturaAuth extends ThreadStoreAuth {
  canCreateThread() {
    return false;
  }
  canAddComment() {
    return false;
  }
  canUpdateComment() {
    return false;
  }
  canDeleteComment() {
    return false;
  }
  canDeleteThread() {
    return false;
  }
  canResolveThread() {
    return false;
  }
  canUnresolveThread() {
    return false;
  }
  canAddReaction() {
    return false;
  }
  canDeleteReaction() {
    return false;
  }
}

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
      className="relative -ml-2 size-7 shrink-0 rounded-full ring-2 ring-surface transition-transform duration-200 ease-out first:ml-0 hover:z-10 hover:-translate-y-0.5"
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
        className={`absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-surface ${
          peer.isAgent ? "bg-ink" : "bg-green-500"
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
          title={peers
            .slice(MAX)
            .map((p) => p.name)
            .join(", ")}
          className="-ml-2 grid size-7 shrink-0 place-items-center rounded-full bg-surface-3 text-[11px] font-semibold text-muted ring-2 ring-surface"
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

export default function CollabEditor({
  wsUrl,
  room,
  token,
  initialHtml,
  agentMd,
  role,
  user,
  onAjustarAncho,
}: {
  wsUrl: string;
  room: string;
  token: string;
  initialHtml: string;
  /**
   * Sobre del documento tal como está en la DB. El panel lo actualiza cuando el AGENTE
   * publica una versión nueva; al cambiar, sus bloques se reconcilian contra la sala
   * (ver el efecto de abajo). Es el cable que mete a Ghosty en el documento abierto.
   */
  agentMd?: string;
  /** Identidad REAL del que edita (server-side, color estable por `sub`). */
  user: CollabUser;
  /**
   * Lo que puede hacer, tal como lo firmó el ticket. `edit` escribe el documento;
   * `comment` NO lo escribe pero sí abre y responde hilos; `view` sólo mira.
   */
  role: DocRole;
  /**
   * Pide más (o menos) ancho a quien contiene el editor, en px. Lo implementa el panel
   * del artefacto; en las páginas de invitado no hay a quién pedirle nada.
   */
  onAjustarAncho?: (delta: number) => void;
}) {
  const t = useT();
  const [status, setStatus] = useState<
    "connecting" | "connected" | "disconnected"
  >("connecting");
  const seeded = useRef(false);
  const editable = role === "edit";

  const ydoc = useMemo(() => new Y.Doc(), []);
  const provider = useMemo(
    () =>
      new HocuspocusProvider({
        url: wsUrl,
        name: room,
        token,
        document: ydoc,
        // ⚠️ NO quitar. Hocuspocus trae `preserveConnection: true` por defecto, y con eso
        // `provider.destroy()` NUNCA cierra el WebSocket: sólo se desengancha del
        // documento y deja el socket vivo, que además se auto-reconecta solo cada 3s.
        // Resultado en prod: cada apertura del editor dejaba un socket colgado, la sala
        // nunca llegaba a cero clientes y por tanto NO se cortaba versión ni se firmaba la
        // autoría. Se veía como gente en el rail de presencia que ya no estaba.
        preserveConnection: false,
      }),
    [wsUrl, room, token, ydoc],
  );
  const [peers, setPeers] = useState<Peer[]>([]);

  // BlockNote sólo consume {name, color} para el caret; el resto viaja en el awareness
  // (lo lee el rail). Memo por identidad para no re-crear el editor en cada render.
  const cursorUser = useMemo(
    () => ({ name: user.name, color: user.color }),
    [user.name, user.color],
  );

  // COMENTARIOS. Los hilos viven en un Y.Map DENTRO del mismo Y.Doc: se sincronizan por
  // el mismo canal que el texto, sobreviven con el mismo `yUpdate`, y el sidecar sigue
  // sin entender de documentos. La alternativa (tabla en sqld) pedía endpoints, permisos
  // aparte y reconciliar anclas a mano.
  //
  // El ancla es una marca sobre el texto, así que abrir un hilo TOCA el documento: por eso
  // el rol `comment` necesita escritura en el Y.Doc y el sidecar sólo deja `readOnly` a
  // `view`. Lo que separa a `comment` de `edit` es esta autorización más el editor no
  // editable — está anotado como límite conocido arriba del sidecar.
  const threadStore = useMemo(
    () =>
      new YjsThreadStore(
        user.sub,
        ydoc.getMap("threads"),
        role === "view"
          ? new SoloLecturaAuth()
          : new DefaultThreadStoreAuth(
              user.sub,
              role === "edit" ? "editor" : "comment",
            ),
      ),
    [ydoc, user.sub, role],
  );

  // Los hilos guardan `userId`, no una copia del nombre. Se resuelve primero contra el
  // awareness (gratis: quien está en la sala ya publicó su nombre) y sólo se le pregunta
  // al servidor por los que no están conectados — el caso normal al abrir un documento
  // con comentarios viejos.
  const cacheUsuarios = useRef(new Map<string, DocUser>());
  const resolveUsers = useMemo(
    () => async (userIds: string[]) => {
      const faltan: string[] = [];
      for (const id of userIds) {
        if (cacheUsuarios.current.has(id)) continue;
        let vivo: DocUser | null = null;
        provider.awareness?.getStates().forEach((state) => {
          const u = (
            state as { user?: { sub?: string; name?: string; avatar?: string } }
          ).user;
          if (u?.sub === id && u.name)
            vivo = { id, username: u.name, avatarUrl: u.avatar || "" };
        });
        if (vivo) cacheUsuarios.current.set(id, vivo);
        else faltan.push(id);
      }
      if (faltan.length) {
        try {
          const res = await resolveDocUsersFn({
            data: { documentId: room, ids: faltan },
          });
          for (const u of res) cacheUsuarios.current.set(u.id, u);
        } catch {
          // Que falle la resolución no debe tumbar el panel de comentarios: se muestran
          // como invitados y el texto del hilo —que es lo que importa— sigue ahí.
          for (const id of faltan)
            cacheUsuarios.current.set(id, {
              id,
              username: "Invitado",
              avatarUrl: "",
            });
        }
      }
      return userIds.map(
        (id) =>
          cacheUsuarios.current.get(id) ?? {
            id,
            username: "Invitado",
            avatarUrl: "",
          },
      );
    },
    [provider, room],
  );

  const editor = useCreateBlockNote(
    {
      extensions: [CommentsExtension({ threadStore, resolveUsers })],
      schema: withMultiColumn(BlockNoteSchema.create()),
      dropCursor: multiColumnDropCursor,
      dictionary: { ...blockNoteEn, multi_column: multiColumnLocales.en },
      collaboration: {
        fragment: ydoc.getXmlFragment("document-store"),
        user: cursorUser,
        provider: { awareness: provider.awareness ?? undefined },
        // "always": la etiqueta con el nombre se queda junto al caret ajeno en vez de
        // aparecer al teclear y desvanecerse. Saber QUIÉN está parado en tu párrafo es
        // media sensación de co-edición.
        showCursorLabels: "always",
      },
    },
    [provider, threadStore],
  );

  useEffect(() => {
    const onStatus = (e: { status: string }) =>
      setStatus(
        e.status === "connected"
          ? "connected"
          : e.status === "connecting"
            ? "connecting"
            : "disconnected",
      );
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
    const me = {
      name: user.name,
      color: user.color,
      avatar: user.avatar,
      sub: user.sub,
    };

    const sync = () => {
      const local = awareness.getLocalState()?.user as
        { sub?: string } | undefined;
      // Re-afirma si y-prosemirror sobrescribió con el objeto pelado del caret.
      if (local?.sub !== user.sub) awareness.setLocalStateField("user", me);

      // Una PERSONA, un avatar. Cada pestaña abre su propia conexión y publica su propio
      // estado de awareness, así que alguien con el documento abierto dos veces salía
      // duplicado en el rail — parecía que había gente que no estaba. Se agrupa por `sub`
      // y gana la entrada propia si la hay.
      const porSub = new Map<string, Peer>();
      awareness.getStates().forEach((state, clientId) => {
        const u = (state as { user?: Partial<Peer> & { avatar?: string; sub?: string } })
          .user;
        if (!u?.name) return;
        const peer: Peer = {
          clientId,
          name: u.name,
          color: u.color || "#737373",
          avatar: u.avatar || undefined,
          isAgent: Boolean(u.isAgent),
          isSelf: clientId === awareness.clientID,
        };
        // La llave NO puede ser sólo `sub`: y-prosemirror sobrescribe el awareness con su
        // objeto pelado de caret (`{name, color}`), así que el `sub` de los OTROS casi
        // nunca llega — sólo el propio, que se re-afirma arriba. Se cae a nombre+color,
        // que el servidor ya deriva del `sub` y por tanto es estable por persona.
        const clave = u.sub || `${u.name}|${u.color ?? ""}`;
        const previo = porSub.get(clave);
        if (!previo || peer.isSelf) porSub.set(clave, peer);
      });
      const next: Peer[] = [...porSub.values()];
      // Orden estable: yo primero, luego el agente, luego el resto por clientId.
      next.sort(
        (a, b) =>
          Number(b.isSelf) - Number(a.isSelf) ||
          Number(b.isAgent) - Number(a.isAgent) ||
          a.clientId - b.clientId,
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
        doc.length <= 1 &&
        (!doc[0] || (doc[0] as { content?: unknown[] }).content?.length === 0);
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

  // GHOSTY EN LA SALA. Cuando el agente publica una versión, el panel nos pasa el sobre
  // nuevo: sus bloques se reconcilian contra lo que hay en la sala, y Yjs propaga el diff
  // a todos los que estén dentro.
  //
  // Por qué en el CLIENTE y no en el servidor: `ServerBlockNoteEditor` NO queda ligado al
  // Y.Doc (el plugin de y-prosemirror necesita un editor montado; en Node no hay vista —
  // comprobado: el fragment quedaba en 0 hijos). Aquí sí hay editor montado, así que se
  // reusa el MISMO `reconcile` del editor simple: conserva el prefijo intacto y toca sólo
  // lo que cambió, en vez de reemplazar el documento entero y pisar lo que estás
  // escribiendo.
  const ultimoMd = useRef<string | null>(null);
  useEffect(() => {
    if (!editor || !editable || !agentMd) return;
    // La PRIMERA vez sólo se toma nota: ese contenido ya está en la sala (o lo acaba de
    // sembrar el efecto de arriba). Reconciliar aquí sería pelearse con la semilla.
    if (ultimoMd.current === null) {
      ultimoMd.current = agentMd;
      return;
    }
    if (ultimoMd.current === agentMd) return;
    ultimoMd.current = agentMd;

    const env = parseDocEnvelope(agentMd);
    const blocks = env?.blocks ?? [];
    if (!blocks.length) return;
    reconcile(editor as unknown as ReconcilableEditor, blocks);
  }, [editor, editable, agentMd]);

  useEffect(
    () => () => {
      provider.destroy();
      ydoc.destroy();
    },
    [provider, ydoc],
  );

  // Cuántos hilos SIN resolver hay, para el contador del botón. Se lee del store, no del
  // editor, para no depender de que el panel esté montado.
  const [abiertos, setAbiertos] = useState(0);
  useEffect(() => {
    const contar = (
      hilos: Map<string, { resolved: boolean; deletedAt?: Date }>,
    ) => {
      let n = 0;
      hilos.forEach((h) => {
        if (!h.resolved && !h.deletedAt) n++;
      });
      setAbiertos(n);
    };
    contar(threadStore.getThreads() as never);
    return threadStore.subscribe(contar as never);
  }, [threadStore]);

  // Los hilos arrancan CERRADOS: el documento es lo que se viene a leer, y un panel
  // abierto de entrada le roba ancho a cambio de nada cuando no hay comentarios.
  //
  // Al abrirlo, el artefacto CRECE en vez de estrujar el documento — por eso se le pide
  // el ancho al panel que lo contiene (`onAjustarAncho`) en lugar de repartir el que ya
  // hay. En las páginas de invitado no hay panel: ahí simplemente no se pide nada.
  const [verHilos, setVerHilos] = useState(false);
  const sidebar = verHilos;
  // Lo que el panel de hilos OCUPA y por tanto lo que le pide al artefacto. Debe coincidir
  // con el ancho del <aside> de abajo: si se piden 340 y se ocupan 380, el documento pierde
  // 40px cada vez que se abren los comentarios.
  const ANCHO_HILOS = 380;

  const alternarHilos = () => {
    setVerHilos((v) => {
      onAjustarAncho?.(v ? -ANCHO_HILOS : ANCHO_HILOS);
      return !v;
    });
  };

  // El panel de hilos se pinta DENTRO de <BlockNoteView> pero aterriza en el <aside> de
  // acá al lado, vía portal. No es rebuscado: los hilos son componentes de Mantine y su
  // provider (más el de componentes) sólo existe para los hijos de BlockNoteView.
  // Montarlo fuera y replicar los providers a mano dejaba el panel EN BLANCO — el
  // comentario existía, sólo que nada lo dibujaba. React propaga contexto a través del
  // portal, así que esto es lo mismo que estar dentro, pero en el lugar correcto.
  const [asideEl, setAsideEl] = useState<HTMLElement | null>(null);

  return (
    // ⚠️ PAPEL vs CROMO. Todo lo de este componente va con los tokens del tema
    // (`bg-surface*`, `text-ink/muted`, `border-border`) — es cromo de la app. Lo ÚNICO
    // que se queda en blanco fijo es la HOJA de más abajo (`data-gt-hoja`): eso es papel,
    // y un documento no cambia de color porque alguien elija tema oscuro. Confundir las
    // dos es lo que dejaba esta pantalla gris de sistema mientras el resto seguía al tema.
    <div className="flex h-full flex-col bg-surface-2">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-surface/90 px-4 py-2 backdrop-blur">
        <span
          className={`inline-block size-2 rounded-full ${
            status === "connected"
              ? "bg-green-500"
              : status === "connecting"
                ? "bg-amber-400"
                : "bg-red-500"
          }`}
        />
        <span className="text-xs font-medium text-muted">
          {status === "connected"
            ? "Co-edición en vivo"
            : status === "connecting"
              ? "Conectando…"
              : "Desconectado"}
          {role === "comment" && " · puedes comentar"}
          {role === "view" && " · solo lectura"}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={alternarHilos}
            aria-pressed={sidebar}
            title={sidebar ? "Ocultar comentarios" : "Mostrar comentarios"}
            className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition ${
              sidebar
                ? "bg-ink text-surface"
                : "text-muted hover:bg-surface-3 hover:text-ink"
            }`}
          >
            <MessageSquare size={14} />
            {abiertos > 0 && <span>{abiertos}</span>}
          </button>
          <PresenceRail peers={peers} />
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="thin-scroll flex-1 overflow-auto px-4 py-8">
          {/* El ancho del documento NO depende del panel de hilos: abrirlos ensancha
                  el artefacto, nunca estruja la lectura. */}
          <div className="mx-auto max-w-[820px]">
            {/* `data-gt-hoja`: lo que Imprimir clona al body para paginar (ver
                    lib/doc-print). Sin esta marca el botón no encontraba nada que
                    imprimir en modo co-edición. */}
            <div
              data-gt-hoja
              className="min-h-[600px] rounded-md bg-white px-6 py-12 shadow-[0_1px_2px_rgba(0,0,0,0.06),0_12px_32px_-12px_rgba(0,0,0,0.18)] ring-1 ring-neutral-200/70 sm:px-14"
            >
              <BlockNoteView editor={editor} editable={editable} theme="light">
                {sidebar && asideEl
                  ? // `filter` va EXPLÍCITO: BlockNote documenta default "all" pero NO lo
                    // aplica — sin él su bucle no empuja ni los resueltos ni los abiertos,
                    // y el panel sale vacío aunque el hilo exista (visto en prod).
                    createPortal(
                      <ThreadsSidebar filter="all" sort="position" />,
                      asideEl,
                    )
                  : null}
              </BlockNoteView>
            </div>
          </div>
        </div>
        {sidebar && (
          <aside className="thin-scroll w-[380px] shrink-0 overflow-y-auto overflow-x-hidden border-l border-border bg-surface px-3 py-4">
            <p className="px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-muted">
              {t("Comentarios")}
            </p>
            {abiertos === 0 && (
              <p className="px-1 text-xs leading-relaxed text-muted">
                {t("Selecciona texto y usa el botón de comentario para abrir un hilo.")}
              </p>
            )}
            {/* Las clases NO son decorativas: TODO el CSS de los hilos que trae BlockNote
                está scopeado bajo `.bn-mantine`, y sus variables de color bajo
                `.bn-container`. El portal mete el React donde toca, pero el DOM aterriza
                aquí — sin estas clases los hilos salen en crudo: nombre y fecha pegados,
                sin tarjeta y sin espaciado. */}
            <div
              ref={setAsideEl}
              className="bn-root bn-container bn-mantine light"
              data-color-scheme="light"
            />
          </aside>
        )}
      </div>
    </div>
  );
}
