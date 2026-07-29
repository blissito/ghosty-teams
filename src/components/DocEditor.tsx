import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { BlockNoteView } from "@blocknote/mantine";
import { useT } from "../i18n";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteSchema } from "@blocknote/core";
import { en as blockNoteEn } from "@blocknote/core/locales";
import {
  withMultiColumn,
  multiColumnDropCursor,
  locales as multiColumnLocales,
} from "@blocknote/xl-multi-column";
import { blockSignature, type DocBlock } from "../lib/doc-blocks";
import { reconcile } from "../lib/doc-reconcile";

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

/**
 * Versiones cuyo cambio YA se señaló en esta pestaña.
 *
 * `changedIds` viaja persistido en el sobre, así que sin esto el documento se resaltaría
 * cada vez que lo abres, incluso una semana después. La marca dice "esto acaba de
 * cambiar", no se queda puesta.
 *
 * Vive en el módulo y se consulta DENTRO del efecto, nunca en el render: un render se
 * puede descartar (Suspense) y repetir, y marcar ahí se come el resaltado.
 */
const yaSenalado = new Set<string>();

const schema = withMultiColumn(BlockNoteSchema.create());
const dictionary = { ...blockNoteEn, multi_column: multiColumnLocales.en };

export default function DocEditor({
  blocks,
  markdown,
  editable,
  streaming,
  onChange,
  highlightIds,
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
  /**
   * uuid de los bloques que cambiaron en esta versión (vienen del sobre). Se señalan al
   * montar: es el caso NORMAL, porque el panel se abre DESPUÉS de que el agente contestó.
   * La detección por diff de abajo sólo cubre el caso raro de tenerlo ya abierto.
   */
  highlightIds?: string[];
}) {
  const t = useT();
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

  // ── Autoscroll mientras el agente escribe ───────────────────────────────────
  // Sigue al texto conforme aparece, pero SÓLO si estás abajo. Si subiste a leer una
  // cláusula anterior, arrastrarte al final en cada tick haría el documento
  // ilegible justo mientras se escribe — que es cuando más se quiere leer.
  const scroller = useRef<HTMLDivElement>(null);
  // El ref lo lee el efecto (sin re-render por tick); el state pinta el botón. Los dos,
  // porque leer el state dentro del efecto lo ataría a su closure.
  const pegado = useRef(true);
  const [alFondo, setAlFondo] = useState(true);

  const alFinal = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 120;

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const v = alFinal(el);
    pegado.current = v;
    setAlFondo((prev) => (prev === v ? prev : v));
  }, []);

  /**
   * Lleva a la vista el primer bloque que cambió y los marca a todos como con
   * marcatextos, unos segundos.
   *
   * Sin esto la edición quirúrgica es invisible: el agente cambia una cláusula en un
   * documento de 74 KB y no hay forma de saber cuál. El aviso decía "1 ajuste" y la
   * persona se quedaba buscando a mano.
   *
   * **El resaltado NO puede vivir en el documento.** Es una clase en el DOM, no una
   * propiedad del bloque: así no entra en la verdad que se persiste ni puede aparecer en
   * el .docx que se descarga. Efímero por construcción, no por acordarse de limpiarlo.
   */
  const marcarCambios = useCallback((ids: string[]): boolean => {
    const cont = scroller.current;
    if (!cont || !ids.length) return false;
    const nodos = ids
      .map((id) => cont.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`))
      .filter((n): n is HTMLElement => !!n);
    // Todavía no están pintados: el llamador reintenta.
    if (!nodos.length) return false;

    // Al primero se va la vista; centrado, que en un documento largo es lo único que
    // deja ver el cambio EN SU CONTEXTO (con `nearest` queda pegado a un borde).
    nodos[0].scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "center",
    });
    // Tras mover la vista a mitad del documento ya no estamos abajo: si no se apunta,
    // el siguiente tick del autoscroll arrastraría de vuelta al final.
    pegado.current = false;
    setAlFondo(false);

    for (const n of nodos) {
      // Re-arrancar la animación si el mismo bloque cambia dos veces seguidas: sin
      // quitar y volver a poner la clase, el navegador la ignora.
      n.classList.remove("gt-cambio");
      void n.offsetWidth;
      n.classList.add("gt-cambio");
    }
    setTimeout(() => nodos.forEach((n) => n.classList.remove("gt-cambio")), 3000);
    return true;
  }, []);

  const irAlFondo = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    // Se vuelve a "pegar" ya: si no, un tick que llegue durante el scroll suave lo
    // cancelaría y el botón se quedaría puesto.
    pegado.current = true;
    setAlFondo(true);
  }, []);

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
    // ¿Es una ACTUALIZACIÓN o la primera pintada? En la primera todo es "nuevo" y
    // resaltar el documento entero no dice nada.
    const esActualizacion = seen.current !== "";
    seen.current = sig;
    // Ids de ANTES, para saber después qué bloques son nuevos. Se mira el documento del
    // editor y no lo que devuelve `reconcile`, porque así da igual qué haga BlockNote con
    // los ids que le pasamos: lo que se resalta es lo que de verdad quedó en pantalla.
    const antes = new Set(((editor.document ?? []) as DocBlock[]).map((b) => b.id));
    applying.current = true;
    try {
      reconcile(editor as never, next);
    } finally {
      // Se libera en microtask: las transacciones de ProseMirror notifican onChange
      // sincrónicamente, pero el editor puede encolar pasos derivados.
      queueMicrotask(() => {
        applying.current = false;
        // Tras el repintado del bloque nuevo, seguir al texto. Va DENTRO del microtask
        // porque antes de que ProseMirror aplique la transacción el `scrollHeight`
        // todavía es el de antes y el salto se quedaría corto.
        const el = scroller.current;
        if (streaming && pegado.current && el) el.scrollTop = el.scrollHeight;

        // Un cambio QUIRÚRGICO ya aplicado: llévame a él y márcalo. No mientras streamea
        // (ahí el texto crece por la cola en cada tick y el autoscroll ya lo sigue), ni en
        // la primera pintada. El tope evita convertir una reescritura completa en un
        // documento entero subrayado, que no señala nada.
        if (!streaming && esActualizacion) {
          const nuevos = ((editor.document ?? []) as DocBlock[])
            .map((b) => b.id)
            .filter((id): id is string => !!id && !antes.has(id));
          if (nuevos.length && nuevos.length <= 8) marcarCambios(nuevos);
        }
      });
    }
  }, [editor, blocks, markdown, streaming]);

  // Señalar lo que cambió al ABRIR. El editor monta con su documento ya puesto, así que
  // no hay diff que hacer: los ids vienen dados.
  //
  // Se REINTENTA en vez de esperar un plazo fijo: BlockNote pinta sus nodos cuando puede,
  // y en un documento de 75 KB eso tarda más que cualquier número que uno elija. Sin
  // reintento el querySelector no encontraba nada y fallaba en silencio.
  useEffect(() => {
    if (!editor || !highlightIds?.length) return;
    const clave = highlightIds.join(",");
    if (yaSenalado.has(clave)) return;
    let intentos = 0;
    let t: ReturnType<typeof setTimeout>;
    const probar = () => {
      if (marcarCambios(highlightIds)) {
        yaSenalado.add(clave); // sólo cuando de verdad se pintó
        return;
      }
      if (++intentos < 20) t = setTimeout(probar, 100); // hasta ~2s
    };
    t = setTimeout(probar, 60);
    return () => clearTimeout(t);
  }, [editor, highlightIds, marcarCambios]);

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
    // `relative` para el botón flotante; el que scrollea es el hijo, no este.
    <div className="relative min-h-0 flex-1">
      {/* `gt-doc` acota el CSS de Mantine: BlockNote trae estilos globales y el panel
          vive en tema oscuro. Todo lo del editor queda dentro de esta clase. */}
      <div
        ref={scroller}
        onScroll={onScroll}
        className="gt-doc h-full overflow-auto bg-surface-3 p-4 thin-scroll sm:p-6"
      >
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

      {/* Ir al final. Sólo cuando NO estás abajo — si no, es un botón que no hace nada
          tapando el documento. Mientras el agente escribe además avisa de que sigue
          llegando texto más abajo. */}
      {!alFondo ? (
        <button
          type="button"
          onClick={irAlFondo}
          aria-label={t("Ir al final")}
          title={t("Ir al final")}
          className="absolute bottom-5 right-5 z-10 inline-flex items-center gap-1.5 rounded-full border border-border bg-surface/95 px-3 py-2 text-xs font-medium text-ink shadow-lg backdrop-blur transition hover:border-brand hover:text-brand"
        >
          <ArrowDown size={14} />
          {streaming ? t("Sigue escribiendo") : t("Ir al final")}
        </button>
      ) : null}
    </div>
  );
}
